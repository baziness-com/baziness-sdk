import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';
import { BazinessError, BazinessServer, stableEventId, transactionIdFor } from '../src/index.js';
import { control, fake, MemoryRefreshTokenStore, sdk, type FakeHub, type HubState } from './fakeHub.js';

let hub: FakeHub;

before(async () => {
  hub = await fake.startFakeHub();
});
after(async () => {
  await hub.close();
});
beforeEach(async () => {
  await control(hub, 'reset', {});
});

const state = () => control<HubState>(hub, 'state');
const device = { deviceId: 'device-1', platform: 'Web', store: 'Direct' } as const;

describe('configuration', () => {
  it('refuses a missing secret and an unknown environment', () => {
    assert.throws(() => new BazinessServer({ environment: 'staging', clientId: 12, clientSecret: ' ' }), /clientSecret/);
    assert.throws(
      () => new BazinessServer({ environment: 'dev' as never, clientId: 12, clientSecret: 'x' }),
      /staging" or "production/,
    );
  });

  it('reads the environment variables', () => {
    const baziness = BazinessServer.fromEnv({
      BAZINESS_ENVIRONMENT: 'production',
      BAZINESS_CLIENT_ID: '12',
      BAZINESS_CLIENT_SECRET: 'secret',
    });
    assert.equal(baziness.environment, 'production');
    assert.equal(baziness.publicConfig().apiUrl, 'https://platform.karizmastudio.com/api');
    assert.equal(baziness.publicConfig().pagesUrl, 'https://baziness.com');
  });
});

describe('client auth', () => {
  it('authenticates once and again after the client token expires', async () => {
    const { baziness } = sdk(hub);
    const { userId } = await baziness.players.signIn(device);
    await baziness.coins.balance(userId);
    await control(hub, 'expire-client-tokens', {});
    assert.equal(await baziness.coins.balance(userId), 0);
    const auths = (await state()).requests.filter((r) => r.path === '/api/client/auth');
    assert.equal(auths.length, 2);
  });

  it('reports a wrong secret as a 401 BazinessError', async () => {
    const { baziness } = sdk(hub, { clientSecret: 'wrong' });
    await assert.rejects(baziness.coins.balance(1), (error: unknown) => {
      assert.ok(error instanceof BazinessError);
      assert.equal(error.status, 401);
      return true;
    });
  });
});

describe('players', () => {
  const accessTokenCalls = async () =>
    (await state()).requests.filter((r) => r.path.startsWith('/api/v2/client/access-token/')).length;

  it('creates a player on first sign-in, then gets a new access token; the server keeps no token', async () => {
    const { baziness } = sdk(hub);
    const first = await baziness.players.signIn({
      ...device,
      attribution: { utmSource: 'instagram', campaignCode: 'spring' },
    });
    assert.equal(first.method, 'created');
    assert.equal(first.isLinkedToAccount, false);
    assert.ok(first.accessToken && Date.parse(first.accessTokenExpiresAt) > Date.now());
    assert.equal((await state()).liveSessions, 0, 'no refresh session on the platform');

    const hubUser = (await state()).users[0]!;
    assert.deepEqual(hubUser.attribution, { utmSource: 'instagram', linkCode: 'spring' });

    // A fresh SDK instance (another server, or after a restart) has no cached token: it asks again.
    const second = await sdk(hub).baziness.players.signIn({ ...device, userId: first.userId });
    assert.equal(second.method, 'refresh');
    assert.equal(second.userId, first.userId);
    assert.notEqual(second.accessToken, first.accessToken);
    assert.equal(await accessTokenCalls(), 1);
    const old = (await state()).requests.filter((r) => r.path === '/api/auth/refresh' || r.path.includes('get-user-token'));
    assert.equal(old.length, 0, 'no refresh tokens and no token pairs');
  });

  it('serves a cached access token while it has time left', async () => {
    const { baziness } = sdk(hub);
    const first = await baziness.players.signIn(device);
    const again = await baziness.players.session(first.userId);
    assert.equal(again.accessToken, first.accessToken);
    assert.equal(await accessTokenCalls(), 0);
  });

  it('asks once when several requests need the same player\'s token at once', async () => {
    const first = await sdk(hub).baziness.players.signIn(device);
    const { baziness } = sdk(hub);
    const results = await Promise.all([1, 2, 3].map(() => baziness.players.session(first.userId)));
    assert.equal(new Set(results.map((r) => r.accessToken)).size, 1);
    assert.equal(await accessTokenCalls(), 1);
  });

  it('joins a player who arrives with a link code to the same person', async () => {
    const yatzy = sdk(hub, { clientId: 13, clientSecret: 'fake-client-secret-13' }).baziness;
    const yatzyPlayer = await yatzy.players.signIn({ deviceId: 'phone', platform: 'Android', store: 'CafeBazaar' });
    const { code } = await control<{ code: string }>(hub, 'link-code', { userId: yatzyPlayer.userId });

    const fal = sdk(hub).baziness;
    const falPlayer = await fal.players.signIn({ ...device, linkCode: code });
    assert.equal(falPlayer.method, 'link_code');
    const users = (await state()).users;
    const accountOf = (id: number) => users.find((u) => u.userId === id)!.accountId;
    assert.ok(accountOf(falPlayer.userId) !== null);
    assert.equal(accountOf(falPlayer.userId), accountOf(yatzyPlayer.userId));
  });

  it('continues without a used link code', async () => {
    const { baziness } = sdk(hub);
    const result = await baziness.players.signIn({ ...device, linkCode: 'lc.expired' });
    assert.equal(result.method, 'created');
    assert.equal(result.linkCodeRejected, true);
  });

  it('keeps a known player when their link code is stale', async () => {
    const { baziness } = sdk(hub);
    const first = await baziness.players.signIn(device);
    const fresh = sdk(hub).baziness;
    const result = await fresh.players.signIn({ ...device, userId: first.userId, linkCode: 'lc.used' });
    assert.equal(result.userId, first.userId);
    assert.equal(result.method, 'refresh');
    assert.equal(result.linkCodeRejected, true);
  });

  it('serves two server instances without coordinating', async () => {
    const first = await sdk(hub).baziness.players.signIn(device);
    const instanceA = sdk(hub).baziness;
    const instanceB = sdk(hub).baziness;
    const [a, b] = await Promise.all([instanceA.players.session(first.userId), instanceB.players.session(first.userId)]);
    assert.equal(a.userId, first.userId);
    assert.equal(b.userId, first.userId);
    assert.equal(a.method, 'refresh');
    assert.equal(b.method, 'refresh');
  });

  it('ends the session a 1.0 integration left in its store at logout', async () => {
    const refreshTokens = new MemoryRefreshTokenStore();
    const { baziness } = sdk(hub, { refreshTokens });
    const player = await baziness.players.signIn(device);
    // What 1.0 did: a token pair, with the refresh token kept by the game.
    const legacy = await baziness.players.newSession(player.userId);
    await refreshTokens.set(player.userId, legacy.refreshToken);
    assert.equal((await state()).liveSessions, 1);

    await baziness.players.logout(player.userId);
    assert.equal(await refreshTokens.get(player.userId), null);
    assert.equal((await state()).liveSessions, 0);
  });

  it('reports a suspended account', async () => {
    const { baziness } = sdk(hub);
    const first = await baziness.players.signIn(device);
    await control(hub, 'suspend', { userId: first.userId });
    const fresh = sdk(hub).baziness;
    await assert.rejects(fresh.players.session(first.userId), (error: unknown) => {
      assert.ok(error instanceof BazinessError);
      assert.equal(error.code, 'account_suspended');
      return true;
    });
  });

  it('verifies a page token and tells which player it belongs to', async () => {
    const { baziness } = sdk(hub);
    const player = await baziness.players.signIn(device);
    assert.deepEqual(await baziness.players.verifyToken(player.accessToken), { valid: true, userId: player.userId });
    assert.deepEqual(await baziness.players.verifyToken('forged'), { valid: false, userId: 0 });
  });

  it('gives a link code per page and logs out', async () => {
    const { baziness } = sdk(hub);
    const player = await baziness.players.signIn(device);
    const first = await baziness.players.linkCode(player.userId);
    const second = await baziness.players.linkCode(player.userId);
    assert.notEqual(first.code, second.code);

    // Logout forgets the cached token: the next session request asks the platform again.
    await baziness.players.logout(player.userId);
    const next = await baziness.players.session(player.userId);
    assert.notEqual(next.accessToken, player.accessToken);
    assert.equal(await accessTokenCalls(), 1);
  });

  it('refuses another game\'s player', async () => {
    const other = sdk(hub, { clientId: 13, clientSecret: 'fake-client-secret-13' }).baziness;
    const stranger = await other.players.signIn(device);
    const { baziness } = sdk(hub);
    await assert.rejects(baziness.players.linkCode(stranger.userId), { status: 403 });
  });
});

describe('coins', () => {
  it('pays a grant once however often it is sent', async () => {
    const { baziness } = sdk(hub);
    const { userId } = await baziness.players.signIn(device);
    const paid = await baziness.coins.add({ userId, amount: 50, grantKey: 'match:17' });
    assert.deepEqual(paid, { credited: 50, alreadyCredited: false, transactionId: transactionIdFor(userId, 50, 'match:17') });
    await baziness.coins.add({ userId, amount: 20, grantKey: 'match:18' });
    const again = await baziness.coins.add({ userId, amount: 50, grantKey: 'match:17' });
    assert.equal(again.alreadyCredited, true);
    assert.equal(await baziness.coins.balance(userId), 70);
  });

  it('insists on an idempotency key', async () => {
    const { baziness } = sdk(hub);
    await assert.rejects(baziness.coins.add({ userId: 1, amount: 5 }), /grantKey/);
  });

  it('matches the documented transaction id format', () => {
    assert.equal(transactionIdFor(239236, 50, 'match:17'), '239236_50_dc3ee6230b3a94ce5764afe9');
  });
});

describe('resilience', () => {
  it('retries a 503 and a dropped connection on idempotent calls', async () => {
    const { baziness } = sdk(hub);
    const { userId } = await baziness.players.signIn(device);
    await control(hub, 'fail', { path: `/api/client/get-coin/${userId}`, status: 503, times: 1 });
    await control(hub, 'fail', { path: `/api/client/get-coin/${userId}`, status: 0, times: 1 });
    assert.equal(await baziness.coins.balance(userId), 0);
  });

  it('does not retry a create after a 500 (it may have happened)', async () => {
    const { baziness } = sdk(hub);
    await control(hub, 'fail', { path: '/api/v2/client/create-user', status: 500, times: 1 });
    await assert.rejects(baziness.players.signIn(device), { status: 500 });
  });

  it('opens the breaker after repeated outages and fails fast', async () => {
    const { baziness } = sdk(hub, { http: { retryBaseMs: 1, maxAttempts: 1, breakerThreshold: 2, breakerResetMs: 60_000 } });
    const { userId } = await baziness.players.signIn(device);
    await control(hub, 'fail', { path: `/api/client/get-coin/${userId}`, status: 503, times: 5 });
    await assert.rejects(baziness.coins.balance(userId), { status: 503 });
    await assert.rejects(baziness.coins.balance(userId), { status: 503 });
    await assert.rejects(baziness.coins.balance(userId), /circuit open/);
  });
});

describe('purchases and analytics', () => {
  it('records a store purchase and its funnel event once', async () => {
    const { baziness } = sdk(hub);
    const { userId } = await baziness.players.signIn(device);
    const purchase = { userId, amount: 49_000, gateway: 'cafebazaar', orderId: 'order-1', sku: 'gems_100' } as const;
    await baziness.purchases.record(purchase);
    await baziness.purchases.record(purchase);
    await baziness.analytics.flush();

    const hubState = await state();
    assert.equal(hubState.purchases.length, 1);
    const completed = hubState.serverEvents.filter((e) => e.eventKey === 'iap_purchase_completed');
    assert.equal(completed.length, 2, 'sent twice …');
    assert.equal(new Set(completed.map((e) => e.eventId)).size, 1, '… with one event id, so it counts once');
    assert.equal(completed[0]!.eventId, stableEventId('purchase:cafebazaar:order-1'));
    assert.equal(completed[0]!.value, 49_000);
  });

  it('rejects purchases it cannot count', async () => {
    const { baziness } = sdk(hub);
    await assert.rejects(baziness.purchases.record({ userId: 1, amount: 10, gateway: 'direct', orderId: 'x' }), /provider/);
    await assert.rejects(baziness.purchases.record({ userId: 1, amount: 10, gateway: 'paypal' as never, orderId: 'x' }), /gateway/);
  });

  it('reports sign-ins, sessions with device data and custom events through the trusted channel', async () => {
    const { baziness } = sdk(hub);
    const { userId } = await baziness.players.signIn(device);
    const sessionId = baziness.analytics.sessions.start(userId, {
      device: { model: 'Pixel 8', os: 'Android', osVersion: '15', screenWidth: 1080, screenHeight: 2400, sdk: 'unity' },
    });
    baziness.analytics.track(userId, 'level_complete', { value: 1200, props: { level: 7 }, sessionId });
    baziness.analytics.sessions.end(userId);
    assert.equal(baziness.analytics.track(userId, 'Bad Name'), false);
    await baziness.analytics.flush();

    const events = (await state()).serverEvents;
    assert.deepEqual(
      events.map((e) => e.eventKey),
      ['auth_login', 'session_start', 'device_info', 'level_complete', 'session_end'],
    );
    assert.equal(events[0]!.props?.method, 'created');
    const deviceInfo = events.find((e) => e.eventKey === 'device_info')!;
    assert.equal(deviceInfo.props?.screen, '1080x2400');
    assert.equal(deviceInfo.sessionId, sessionId);
    assert.equal(events.find((e) => e.eventKey === 'level_complete')!.props?.level, '7');
  });

  it('ensure keeps one session across repeated session requests', async () => {
    const { baziness } = sdk(hub);
    const { userId } = await baziness.players.signIn(device);
    const first = baziness.analytics.sessions.ensure(userId, { device: { model: 'x' } });
    assert.equal(baziness.analytics.sessions.ensure(userId), first);
    baziness.analytics.sessions.end(userId);
    assert.notEqual(baziness.analytics.sessions.ensure(userId), first);
  });

  it('ends an activity session after the idle timeout', async () => {
    const { baziness } = sdk(hub, { analytics: { flushIntervalMs: 60_000, heartbeatMs: 20, idleTimeoutMs: 30 } });
    const { userId } = await baziness.players.signIn(device);
    const id = baziness.analytics.sessions.touch(userId);
    assert.equal(baziness.analytics.sessions.touch(userId), id, 'activity within the timeout keeps the session');
    await new Promise((resolve) => setTimeout(resolve, 120));
    assert.equal(baziness.analytics.sessions.current(userId), undefined);
    await baziness.analytics.flush();
    const keys = (await state()).serverEvents.map((e) => e.eventKey);
    assert.ok(keys.includes('session_end'));
  });

  it('keeps events while the platform is unavailable and sends them later', async () => {
    const { baziness } = sdk(hub, { http: { retryBaseMs: 1, maxAttempts: 1, breakerThreshold: 0 } });
    const { userId } = await baziness.players.signIn(device);
    await control(hub, 'fail', { path: '/api/analytics/server-events/batch', status: 503, times: 1 });
    baziness.analytics.track(userId, 'tutorial_complete');
    await baziness.analytics.flush();
    assert.equal(baziness.analytics.pending, 2, 'kept after the 503');
    await baziness.close(1000); // close sends the rest without waiting for the backoff
    assert.equal(baziness.analytics.pending, 0);
    assert.ok((await state()).serverEvents.some((e) => e.eventKey === 'tutorial_complete'));
  });

  it('advances a quest', async () => {
    const { baziness } = sdk(hub);
    const { userId } = await baziness.players.signIn(device);
    await baziness.quests.progress(userId, 'example/win', 2);
    assert.deepEqual((await state()).quests, [{ userId, questEventName: 'example/win', progressCount: 2 }]);
  });
});
