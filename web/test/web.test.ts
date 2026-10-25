import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { after, before, beforeEach, describe, it } from 'node:test';
import { DeviceAnalytics } from '../src/analytics.js';
import { CoinBalance } from '../src/coins.js';
import { parseBrowser, parseOs } from '../src/device.js';
import { readLaunch } from '../src/launch.js';
import { pageUrl, parsePageMessage } from '../src/pages.js';
import { SessionManager } from '../src/session.js';
import { memoryStore } from '../src/storage.js';
import type { GameBackend } from '../src/backend.js';

interface FakeHub {
  port: number;
  apiBase: string;
  close(): Promise<void>;
}
const fake = (await import(pathToFileURL(resolve(process.cwd(), '../tools/fake-hub/fake-hub.mjs')).href)) as {
  startFakeHub(): Promise<FakeHub>;
  FAKE_CLIENT: { clientId: number; clientSecret: string };
};

let hub: FakeHub;
before(async () => {
  hub = await fake.startFakeHub();
});
after(() => hub.close());
beforeEach(() => control('reset', {}));

async function control<T = unknown>(path: string, body?: unknown): Promise<T> {
  const response = await fetch(`http://127.0.0.1:${hub.port}/__control/${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return (await response.json()) as T;
}

/** A game server in miniature: what a real one does with the server SDK, straight against the fake hub. */
async function gameServer() {
  const auth = await (await fetch(`${hub.apiBase}/client/auth`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(fake.FAKE_CLIENT),
  })).json() as { token: string };
  const headers = { 'Content-Type': 'application/json', Authorization: `Bearer ${auth.token}` };
  let userId = 0;
  const calls: string[] = [];
  const backend: GameBackend = {
    async session(request) {
      calls.push(`session:${request.linkCode ?? '-'}`);
      const answer = await (await fetch(`${hub.apiBase}/v2/client/create-user`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ deviceId: request.device.deviceId, platform: 'Web', store: 'Direct', linkCode: request.linkCode }),
      })).json() as { userId: number; isLinkedToAccount: boolean; tokens: { accessToken: string; accessTokenExpiresAt: string } };
      userId = answer.userId;
      return { userId, isLinkedToAccount: answer.isLinkedToAccount, accessToken: answer.tokens.accessToken, accessTokenExpiresAt: answer.tokens.accessTokenExpiresAt };
    },
    async linkCode() {
      const answer = await (await fetch(`${hub.apiBase}/v2/client/link-code/${userId}`, { method: 'POST', headers })).json() as { code: string };
      return answer.code;
    },
    async login() {
      return {};
    },
    async logout() {
      return {};
    },
  };
  return { backend, calls, userId: () => userId };
}

const device = { deviceId: 'web-device', platform: 'Web', store: 'Direct', deviceType: 'desktop', sdk: 'web', sdkVersion: '1.0.0' } as const;

describe('launch parameters', () => {
  it('keeps the first touch, takes the link code once and cleans the address', () => {
    const store = memoryStore();
    const first = readLaunch(
      'https://game.example/play?utm_source=instagram&utm_campaign=spring&bz_lc=c1&bz_click=k9&linkCode=abc&level=3',
      'https://instagram.com/',
      store,
      new Date('2026-10-24T10:00:00Z'),
    );
    assert.equal(first.launch.linkCode, 'abc');
    assert.deepEqual(first.launch.attribution, {
      utmSource: 'instagram',
      utmCampaign: 'spring',
      campaignCode: 'c1',
      clickId: 'k9',
      landedAt: '2026-10-24T10:00:00.000Z',
      referrer: 'https://instagram.com/',
    });
    assert.equal(first.cleanHref, 'https://game.example/play?level=3');

    const later = readLaunch('https://game.example/?utm_source=telegram', '', store);
    assert.equal(later.launch.attribution?.utmSource, 'instagram', 'a later campaign never replaces the first touch');
    assert.equal(later.launch.linkCode, null);
  });

  it('leaves a clean address alone', () => {
    assert.equal(readLaunch('https://game.example/play', '', memoryStore()).cleanHref, null);
  });
});

describe('pages', () => {
  it('builds each page with the parameters the wiki lists', () => {
    const base = { pagesBase: 'https://baziness.com', packageName: 'com.example.game', gameName: 'فال', linkCode: 'lc1', sdkVersion: '1.0.0' };
    const shop = new URL(pageUrl({ ...base, page: 'shop' }));
    assert.equal(shop.pathname, '/shop');
    assert.equal(shop.searchParams.get('game_name'), 'فال');
    assert.equal(shop.searchParams.get('sdkType'), 'js');
    assert.equal(shop.searchParams.get('linkCode'), 'lc1');
    assert.equal(shop.searchParams.get('redirect'), 'shop');
    assert.equal(shop.searchParams.get('allowGuest'), null);
    assert.equal(shop.searchParams.has('linkedToken'), false);

    const login = new URL(pageUrl({ ...base, page: 'login' }));
    assert.equal(login.pathname, '/');
    assert.equal(login.searchParams.get('allowGuest'), 'false');
    assert.equal(login.searchParams.get('game_name'), null);
  });

  it('understands every page message and nothing else', () => {
    assert.deepEqual(parsePageMessage('{"type":"close"}'), { type: 'close' });
    assert.deepEqual(parsePageMessage({ type: 'login', data: 'tok' }), { type: 'login', token: 'tok' });
    assert.deepEqual(parsePageMessage({ type: 'login', data: { token: 'tok' } }), { type: 'login', token: 'tok' });
    assert.deepEqual(parsePageMessage({ type: 'login' }), { type: 'login' });
    assert.deepEqual(parsePageMessage({ type: 'token', data: 'x' }), { type: 'token' });
    assert.deepEqual(parsePageMessage({ type: 'open_url', data: 'https://x.example' }), { type: 'open_url', url: 'https://x.example' });
    assert.equal(parsePageMessage({ type: 'open_url', data: 'javascript:alert(1)' }), null);
    assert.equal(parsePageMessage('not json'), null);
    assert.equal(parsePageMessage({ type: 'unknown' }), null);
  });
});

describe('device', () => {
  it('reads the OS and browser from common user agents', () => {
    const android = 'Mozilla/5.0 (Linux; Android 14; SM-A546E) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Mobile Safari/537.36';
    assert.deepEqual(parseOs(android), { os: 'Android', osVersion: '14' });
    assert.equal(parseBrowser(android), 'Chrome 129');
    const iphone = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Mobile/15E148 Safari/604.1';
    assert.deepEqual(parseOs(iphone), { os: 'iOS', osVersion: '18.1' });
    assert.equal(parseBrowser(iphone), 'Safari 18');
  });
});

describe('session, coins and analytics against the platform', () => {
  it('sends the launch link code once and reuses the token until it nears expiry', async () => {
    const server = await gameServer();
    const sessions = new SessionManager(server.backend, device, { linkCode: 'lc.stale', attribution: null });
    await assert.rejects(sessions.get(), 'the fake game server does not fall back on a stale code');
    await sessions.get();
    await sessions.get();
    assert.deepEqual(server.calls, ['session:lc.stale', 'session:-']);
  });

  it('reads the balance with the player token', async () => {
    const server = await gameServer();
    const sessions = new SessionManager(server.backend, device, { linkCode: null, attribution: null });
    await sessions.get();
    const coins = new CoinBalance(hub.apiBase, (force) => sessions.token(force), fetch);
    assert.equal(await coins.balance(), 0);
  });

  it('queues events in storage, refuses server-only names and sends one batch', async () => {
    const server = await gameServer();
    const sessions = new SessionManager(server.backend, device, { linkCode: null, attribution: null });
    await sessions.get();
    const store = memoryStore();
    const analytics = new DeviceAnalytics(hub.apiBase, (force) => sessions.token(force), store, 'com.example.game', fetch, { flushIntervalMs: 60_000 });
    analytics.sessionId = 'session-1';
    assert.equal(analytics.track('level_complete', { value: 1200, props: { level: 7 } }), true);
    assert.equal(analytics.track('session_start'), false, 'server-only');
    assert.equal(analytics.track('Level Complete'), false, 'invalid name');
    assert.ok(store.get('baziness:events:com.example.game'), 'persisted before sending');

    // A reload: a new instance picks the queue up from storage.
    const reloaded = new DeviceAnalytics(hub.apiBase, (force) => sessions.token(force), store, 'com.example.game', fetch, { flushIntervalMs: 60_000 });
    reloaded.sessionId = 'session-1';
    await reloaded.flush();
    analytics.stop();
    reloaded.stop();
    assert.equal(reloaded.pending, 0);
    assert.equal(store.get('baziness:events:com.example.game'), null);

    const state = await control<{ deviceEvents: Array<{ eventKey: string; value?: number; props?: Record<string, string>; sessionId?: string }> }>('state');
    assert.equal(state.deviceEvents.length, 1);
    assert.equal(state.deviceEvents[0]!.eventKey, 'level_complete');
    assert.equal(state.deviceEvents[0]!.props?.level, '7');
    assert.equal(state.deviceEvents[0]!.sessionId, 'session-1');
  });

  it('keeps the queue while the platform is down', async () => {
    const server = await gameServer();
    const sessions = new SessionManager(server.backend, device, { linkCode: null, attribution: null });
    await sessions.get();
    await control('fail', { path: '/api/analytics/events/batch', status: 503, times: 1 });
    const analytics = new DeviceAnalytics(hub.apiBase, (force) => sessions.token(force), memoryStore(), 'g', fetch, { flushIntervalMs: 60_000 });
    analytics.track('tutorial_complete');
    await analytics.flush();
    assert.equal(analytics.pending, 1);
    await analytics.flush(true); // a page hide sends at once, despite the backoff
    assert.equal(analytics.pending, 0);
    analytics.stop();
  });
});
