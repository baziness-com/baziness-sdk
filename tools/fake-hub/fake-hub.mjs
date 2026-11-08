#!/usr/bin/env node
// An in-memory stand-in for the Baziness platform API, implementing the contract the SDKs are
// written against (client auth, users with long-lived tokens, link codes, coins, purchases,
// analytics) and Baziness Pay's game-facing calls (under /pay). Every
// SDK's tests run against it, so they all agree on one behaviour.
//
//   node fake-hub.mjs [port]          → prints "fake-hub listening on <port>"
//
// Test control (no auth): POST /__control/reset, POST /__control/fail {path, status, times, error},
// POST /__control/expire-client-tokens, POST /__control/link-code {userId, targetClientId?},
// POST /__control/offer {playerId, bundleId}, POST /__control/referral-rewards {userId, count},
// POST /__control/client-wallet {clientId, balance}, POST /__control/drop-after-credit {times},
// POST /__control/click {linkCode, clickId?, utmSource?, utmMedium?, utmCampaign?, ip?} (a campaign
// link click for fingerprint attribution), POST /__control/pay-payment {uid, sku, pname?, status?},
// POST /__control/drop-after-consume {times}, GET /__control/state.

import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import { pathToFileURL } from 'node:url';

const CLIENTS = new Map([
  [12, { secret: 'fake-client-secret-12', name: 'example' }],
  [13, { secret: 'fake-client-secret-13', name: 'other-game' }],
]);
const HUB_CLIENT_ID = 4;
// Player tokens are long-lived, like the platform's (10 years).
const USER_TOKEN_MS = 3650 * 86_400_000;
const SERVER_ONLY = new Set(['session_start', 'session_heartbeat', 'session_end', 'device_info', 'iap_purchase_completed', 'auth_login']);
const EVENT_NAME = /^[a-z0-9_:.-]{1,128}$/;
// Apps registered in the fake Baziness Pay (its `pname`); any other answers `no_required_params`, like Pay.
const PAY_APPS = new Set(['com.example.game']);

function freshState() {
  return {
    nextUserId: 1000,
    nextAccountId: 1,
    accounts: new Map(), // accountId → { accountId, phone|null }
    users: new Map(), // userId → { userId, clientId, deviceId, platform, store, accountId|null, attribution }
    clientTokens: new Map(), // token → clientId
    userTokens: new Map(), // token → { userId, expiresAt }
    linkCodes: new Map(), // code → { userId, expiresAt, consumed, targetClientId }
    coins: new Map(), // userId → balance
    credited: new Set(), // transactionIds
    clientWallets: new Map(), // clientId → coins left to pay out (no entry: unlimited)
    dropAfterCredit: 0, // add-coin calls that credit and then lose their answer
    purchases: [],
    serverEvents: [],
    deviceEvents: [],
    quests: [],
    ads: new Map(), // client id -> { ad, status }
    adEvents: [],
    offers: new Map(), // the game's own player id → bundle id
    referralRewards: new Map(), // userId → collectable referral rewards
    clicks: [], // campaign link clicks: { clickId, linkCode, utmSource, utmMedium, utmCampaign, ip, takenBy }
    fingerprints: [], // { userId, via, ip, userAgent, deviceModel, osVersion } each campaign lookup saw
    payments: [], // Baziness Pay: { pname, uid, sku, token, status: ready|purchased|consumed, amount, transactionId }
    dropAfterConsume: 0, // pay consume calls that consume and then lose their answer
    failures: [], // { path, status, times, error }
    requests: [], // { method, path }
  };
}

let state = freshState();

const token = (prefix) => `${prefix}.${randomBytes(18).toString('base64url')}`;

function jwt(claims) {
  const part = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  return `${part({ alg: 'HS256', typ: 'JWT' })}.${part(claims)}.${randomBytes(16).toString('base64url')}`;
}

// client/create-user and client/get-user-token: the player's long-lived token.
function userSession(user) {
  const expiresAt = Date.now() + USER_TOKEN_MS;
  const userToken = jwt({ sub: String(user.userId), role: 'user', exp: Math.floor(expiresAt / 1000) });
  state.userTokens.set(userToken, { userId: user.userId, expiresAt });
  return { userId: user.userId, token: userToken, isLinkedToAccount: isLinked(user) };
}

const isLinked = (user) => user.accountId !== null && state.accounts.get(user.accountId)?.phone != null;

// ── install campaigns, as the platform's analytics answers them ──
// Simplified fingerprint: an Android or iOS install that came with no campaign takes the latest
// untaken click from the same IP (the platform also checks time, platform, model and OS version).

const hasCampaign = (a) => Boolean(a && (a.utmSource || a.linkCode || a.clickId || /utm_|bz_lc|lc=/.test(a.referrer ?? '')));
const sameIp = (ip) => (ip ?? '').replace(/^::ffff:/, '').replace(/^::1$/, '127.0.0.1');

function matchFingerprint(user, device, via) {
  state.fingerprints.push({ userId: user.userId, via, ...device });
  if (hasCampaign(user.attribution) || user.campaignClick || !/^(android|ios)$/i.test(user.platform ?? '')) return;
  const click = state.clicks.filter((c) => !c.takenBy && sameIp(c.ip) === sameIp(device.ip)).at(-1);
  if (!click) return;
  click.takenBy = user.userId;
  user.campaignClick = click;
}

function campaignOf(user) {
  const now = new Date().toISOString();
  const empty = { utmSource: '', utmMedium: '', utmCampaign: '', utmContent: '', utmTerm: '', linkCode: '', clickId: '' };
  const view = (status, matchType, fields) => ({
    found: true, status, matchType, channel: fields.utmSource || status, ...empty, ...fields,
    installStore: (user.store ?? '').toLowerCase(), firstSeen: user.createdAt ?? now,
    attributedAt: status === 'attributed' ? now : null,
  });
  if (hasCampaign(user.attribution)) {
    const a = user.attribution;
    return view('attributed', 'deterministic', {
      utmSource: a.utmSource ?? '', utmMedium: a.utmMedium ?? '', utmCampaign: a.utmCampaign ?? '',
      utmContent: a.utmContent ?? '', utmTerm: a.utmTerm ?? '', linkCode: a.linkCode ?? '', clickId: a.clickId ?? '',
    });
  }
  const c = user.campaignClick;
  if (c) {
    return view('attributed', 'probabilistic', {
      utmSource: c.utmSource ?? '', utmMedium: c.utmMedium ?? '', utmCampaign: c.utmCampaign ?? '', linkCode: c.linkCode, clickId: c.clickId,
    });
  }
  return view(/^(android|ios)$/i.test(user.platform ?? '') ? 'pending' : 'organic', 'none', {});
}

function accountOf(userId) {
  return state.users.get(userId)?.accountId ?? null;
}

function sendJson(res, status, body) {
  const text = body === undefined ? '' : JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(text);
}

const fail = (res, status, error) => sendJson(res, status, { success: false, error });

function bearer(req) {
  const header = req.headers.authorization ?? '';
  return header.startsWith('Bearer ') ? header.slice(7) : null;
}

function clientOf(req) {
  const value = bearer(req);
  return value ? state.clientTokens.get(value) ?? null : null;
}

function userOfToken(value) {
  const entry = state.userTokens.get(value);
  if (!entry || entry.expiresAt < Date.now()) return null;
  return state.users.get(entry.userId) ?? null;
}

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const text = Buffer.concat(chunks).toString('utf8');
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    return { __invalid: true };
  }
}

function consumeLinkCode(code, clientId) {
  const entry = state.linkCodes.get(code);
  if (!entry || entry.consumed || entry.expiresAt < Date.now()) return null;
  if (entry.targetClientId && entry.targetClientId !== clientId) return null;
  entry.consumed = true;
  return entry.userId;
}

function createUser(clientId, body) {
  let accountId = null;
  if (body.linkCode) {
    const linkedUserId = consumeLinkCode(body.linkCode, clientId);
    if (linkedUserId === null) return { error: 'invalid_link_code' };
    const linked = state.users.get(linkedUserId);
    accountId = linked.accountId;
    if (accountId === null) {
      // A phoneless account joins the two installs into one person.
      accountId = state.nextAccountId++;
      state.accounts.set(accountId, { accountId, phone: null });
      linked.accountId = accountId;
    }
    const existing = [...state.users.values()].find((u) => u.accountId === accountId && u.clientId === clientId);
    if (existing) return { user: existing };
  }
  const user = {
    userId: state.nextUserId++,
    clientId,
    deviceId: body.deviceId,
    platform: body.platform,
    store: body.store,
    accountId,
    attribution: body.attribution ?? null,
    createdAt: new Date().toISOString(),
  };
  state.users.set(user.userId, user);
  return { user };
}

function ingest(events, source) {
  const errors = [];
  let accepted = 0;
  events.forEach((event, index) => {
    if (!EVENT_NAME.test(event.eventKey ?? '')) {
      errors.push(`${index}: event name may only contain a-z 0-9 _ : . -`);
      return;
    }
    accepted++;
    (source === 'server' ? state.serverEvents : state.deviceEvents).push(event);
  });
  return { accepted, errors };
}

async function handle(req, res) {
  const url = new URL(req.url, 'http://fake');
  const path = url.pathname;
  const body = req.method === 'POST' ? await readBody(req) : {};
  if (!path.startsWith('/__control')) state.requests.push({ method: req.method, path });

  // ── test control ──
  if (path === '/__control/reset') {
    state = freshState();
    return sendJson(res, 200, { ok: true });
  }
  if (path === '/__control/fail') {
    state.failures.push({ path: body.path, status: body.status, times: body.times ?? 1, error: body.error });
    return sendJson(res, 200, { ok: true });
  }
  if (path === '/__control/expire-client-tokens') {
    state.clientTokens.clear();
    return sendJson(res, 200, { ok: true });
  }
  if (path === '/__control/link-code') {
    const code = token('lc');
    state.linkCodes.set(code, { userId: body.userId, expiresAt: Date.now() + 120_000, consumed: false, targetClientId: body.targetClientId ?? null });
    return sendJson(res, 200, { code });
  }
  if (path === '/__control/phone-login') {
    const user = state.users.get(body.userId);
    let accountId = user.accountId;
    if (accountId === null) {
      accountId = state.nextAccountId++;
      user.accountId = accountId;
    }
    state.accounts.set(accountId, { accountId, phone: body.phone ?? '09120000000' });
    return sendJson(res, 200, { accountId });
  }
  if (path === '/__control/client-wallet') {
    state.clientWallets.set(body.clientId, body.balance);
    return sendJson(res, 200, { ok: true });
  }
  if (path === '/__control/drop-after-credit') {
    state.dropAfterCredit = body.times ?? 1;
    return sendJson(res, 200, { ok: true });
  }
  if (path === '/__control/pay-payment') {
    // A player paid on the checkout page (status `purchased`), or left it at the gateway (`ready`).
    const payment = {
      pname: body.pname ?? 'com.example.game',
      uid: Number(body.uid),
      sku: body.sku,
      token: body.token ?? token('A'),
      status: body.status ?? 'purchased',
      amount: body.amount ?? 49000,
      transactionId: token('tx'),
    };
    state.payments.push(payment);
    return sendJson(res, 200, payment);
  }
  if (path === '/__control/drop-after-consume') {
    state.dropAfterConsume = body.times ?? 1;
    return sendJson(res, 200, { ok: true });
  }
  if (path === '/__control/ad') {
    state.ads.set(body.clientId ?? FAKE_CLIENT.clientId, { ad: body.ad ?? null, status: body.status ?? 200 });
    return sendJson(res, 200, { ok: true });
  }
  if (path === '/__control/offer') {
    state.offers.set(body.playerId, body.bundleId);
    return sendJson(res, 200, { ok: true });
  }
  if (path === '/__control/referral-rewards') {
    state.referralRewards.set(body.userId, body.count);
    return sendJson(res, 200, { ok: true });
  }
  if (path === '/__control/suspend') {
    state.users.get(body.userId).suspended = true;
    return sendJson(res, 200, { ok: true });
  }
  if (path === '/__control/click') {
    const click = { clickId: body.clickId ?? token('click'), linkCode: body.linkCode ?? 'test-link', utmSource: body.utmSource ?? '',
      utmMedium: body.utmMedium ?? '', utmCampaign: body.utmCampaign ?? '', ip: body.ip ?? '127.0.0.1', takenBy: null };
    state.clicks.push(click);
    return sendJson(res, 200, { clickId: click.clickId });
  }
  if (path === '/__control/state') {
    return sendJson(res, 200, {
      fingerprints: state.fingerprints,
      users: [...state.users.values()],
      purchases: state.purchases,
      adEvents: state.adEvents,
      serverEvents: state.serverEvents,
      deviceEvents: state.deviceEvents,
      quests: state.quests,
      payments: state.payments,
      coins: Object.fromEntries(state.coins),
      requests: state.requests,
    });
  }

  // ── injected failures ──
  const failure = state.failures.find((f) => f.path === path && f.times > 0);
  if (failure) {
    failure.times--;
    return failure.status === 0 ? req.socket.destroy() : fail(res, failure.status, failure.error ?? 'injected');
  }

  // ── Baziness Pay (its own server; no auth, answers 200 with success false like Pay) ──
  if (path.startsWith('/pay/') && req.method === 'POST') return pay(path.slice('/pay'.length), body, req, res);

  // ── unauthenticated ──
  if (path === '/api/client/auth' && req.method === 'POST') {
    const client = CLIENTS.get(body.clientId);
    if (!client || client.secret !== body.clientSecret) return fail(res, 401, 'invalid client');
    const value = jwt({ sub: String(body.clientId), role: 'client', exp: Math.floor((Date.now() + 3_600_000) / 1000) });
    state.clientTokens.set(value, body.clientId);
    return sendJson(res, 200, { clientId: body.clientId, token: value });
  }

  // ── user token ──
  if (path === '/api/user/get-coin' && req.method === 'GET') {
    const user = userOfToken(bearer(req) ?? '');
    if (!user) return fail(res, 401, 'unauthorized');
    return sendJson(res, 200, { resourceId: 1, amount: state.coins.get(user.userId) ?? 0 });
  }
  if (path === '/api/analytics/events/batch' && req.method === 'POST') {
    const user = userOfToken(bearer(req) ?? '');
    if (!user) return fail(res, 401, 'unauthorized');
    const events = body.events ?? [];
    if (events.length > 100) return fail(res, 400, 'at most 100 events per batch');
    const errors = [];
    const forwarded = [];
    events.forEach((event, index) => {
      if (user.clientId !== HUB_CLIENT_ID && SERVER_ONLY.has(event.eventKey)) {
        errors.push(`${index}: ${event.eventKey} is accepted only from your game server (server-events/batch)`);
      } else forwarded.push({ ...event, userId: user.userId, sessionId: event.sessionId ?? body.sessionId });
    });
    const result = ingest(forwarded, 'device');
    return sendJson(res, 200, { accepted: result.accepted, rejected: errors.length + result.errors.length, errors: [...errors, ...result.errors] });
  }
  if (path === '/api/user/referral-collectable-accounts-count' && req.method === 'GET') {
    const user = userOfToken(bearer(req) ?? '');
    if (!user) return fail(res, 401, 'unauthorized');
    // Like the hub: a bare number.
    return sendJson(res, 200, state.referralRewards.get(user.userId) ?? 0);
  }
  if (path === '/api/analytics/attribution' && req.method === 'POST') {
    const user = userOfToken(bearer(req) ?? '');
    if (!user) return fail(res, 401, 'unauthorized');
    if (user.attribution) return sendJson(res, 200, { outcome: 'already_final' });
    user.attribution = body;
    return sendJson(res, 200, { outcome: 'applied' });
  }
  if (path === '/api/analytics/attribution/resolve' && req.method === 'POST') {
    // The player's own device: its request's IP and User-Agent, plus what the app adds.
    const user = userOfToken(bearer(req) ?? '');
    if (!user) return fail(res, 401, 'unauthorized');
    matchFingerprint(user, { ip: req.socket.remoteAddress, userAgent: req.headers['user-agent'] ?? '',
      deviceModel: body.deviceModel ?? '', osVersion: body.osVersion ?? '' }, 'device');
    return sendJson(res, 200, campaignOf(user));
  }

  // ── client token ──
  const clientId = clientOf(req);
  if (!clientId) return fail(res, 401, 'unauthorized');
  const ownUser = (userId) => {
    const user = state.users.get(Number(userId));
    return user && user.clientId === clientId ? user : null;
  };

  if (path === '/api/client/create-user' && req.method === 'POST') {
    if (!body.deviceId) return fail(res, 400, 'deviceId is required');
    const result = createUser(clientId, body);
    if (result.error) return fail(res, 400, result.error);
    return sendJson(res, 200, userSession(result.user));
  }
  let match = path.match(/^\/api\/v2\/client\/attribution\/(\d+)$/);
  if (match && req.method === 'POST') {
    // A game server, passing on the device it saw.
    const user = state.users.get(Number(match[1]));
    if (!user || user.clientId !== clientId) return fail(res, 403, `user ${match[1]} does not belong to this client`);
    if (body.ip) {
      matchFingerprint(user, { ip: body.ip, userAgent: body.userAgent ?? '', deviceModel: body.deviceModel ?? '',
        osVersion: body.osVersion ?? '' }, 'server');
    }
    return sendJson(res, 200, campaignOf(user));
  }
  match = path.match(/^\/api\/client\/get-user-token\/(\d+)$/);
  if (match && req.method === 'GET') {
    const user = ownUser(match[1]);
    if (!user) return fail(res, 403, 'access denied');
    if (user.suspended) return fail(res, 403, 'account_suspended');
    return sendJson(res, 200, userSession(user));
  }
  match = path.match(/^\/api\/v2\/client\/link-code\/(\d+)$/);
  if (match && req.method === 'POST') {
    const user = ownUser(match[1]);
    if (!user) return fail(res, 403, 'access denied');
    const code = token('lc');
    const expiresAt = Date.now() + 120_000;
    state.linkCodes.set(code, { userId: user.userId, expiresAt, consumed: false, targetClientId: HUB_CLIENT_ID });
    return sendJson(res, 200, { code, expiresAt: new Date(expiresAt).toISOString() });
  }
  if (path === '/api/client/validate-user-token' && req.method === 'POST') {
    const user = userOfToken(body.token ?? '');
    return sendJson(res, 200, user ? { userId: user.userId, isValid: true } : { userId: 0, isValid: false });
  }
  if (path === '/api/client/add-coin' && req.method === 'POST') {
    const user = ownUser(body.userId);
    if (!user) return fail(res, 400, 'user does not belong to this client');
    // Like the hub, every refusal reads the same: already paid, or the game's wallet is short.
    if (state.credited.has(body.transactionId)) return fail(res, 400, 'add resource failed');
    const wallet = state.clientWallets.get(clientId);
    if (wallet !== undefined && wallet < body.amount) return fail(res, 400, 'add resource failed');
    if (wallet !== undefined) state.clientWallets.set(clientId, wallet - body.amount);
    state.credited.add(body.transactionId);
    state.coins.set(user.userId, (state.coins.get(user.userId) ?? 0) + body.amount);
    if (state.dropAfterCredit > 0) {
      state.dropAfterCredit--;
      return req.socket.destroy();
    }
    // Like the hub: the answer carries the amount credited, not the new balance.
    return sendJson(res, 200, { resourceId: 1, amount: body.amount });
  }
  match = path.match(/^\/api\/client\/get-coin\/(\d+)$/);
  if (match && req.method === 'GET') {
    const user = ownUser(match[1]);
    if (!user) return fail(res, 403, 'access denied');
    return sendJson(res, 200, { resourceId: 1, amount: state.coins.get(user.userId) ?? 0 });
  }
  match = path.match(/^\/api\/client\/account-data\/(\d+)$/);
  if (match && req.method === 'GET') {
    const user = ownUser(match[1]);
    if (!user) return fail(res, 403, 'access denied');
    const account = user.accountId ? state.accounts.get(user.accountId) : null;
    return sendJson(res, 200, account?.phone ? { accountId: account.accountId, phoneNumber: account.phone, fullName: '', nationalCode: '', isActive: true } : null);
  }
  match = path.match(/^\/api\/client\/check-phone-number\/([^/]+)$/);
  if (match && req.method === 'GET') {
    // The player of THIS game whose Baziness account has the phone number.
    const phone = decodeURIComponent(match[1]);
    const owner = [...state.users.values()].find(
      (user) => user.clientId === clientId && user.accountId !== null && state.accounts.get(user.accountId)?.phone === phone,
    );
    return sendJson(res, 200, owner ? { isRegistered: true, userId: owner.userId } : { isRegistered: false, userId: null });
  }
  if (path === '/api/content/get-ad' && req.method === 'GET') {
    const slot = state.ads.get(clientId);
    if (!slot || slot.status === 204) { res.writeHead(204); return res.end(); }
    return sendJson(res, slot.status, slot.ad);
  }
  if (path === '/api/content/ad-event' && req.method === 'POST') {
    if (!ownUser(body.userId) || body.adId <= 0 || !['seen', 'click'].includes(body.eventType)) return fail(res, 400, 'invalid ad event');
    state.adEvents.push({ ...body, clientId });
    res.writeHead(204);
    return res.end();
  }
  if (path === '/api/client/get-user-offer' && req.method === 'POST') {
    const bundleId = state.offers.get(body.user_id);
    return sendJson(res, 200, bundleId == null ? { bundle_id: null, code: 'no_offer', message: 'no offer' } : { bundle_id: bundleId, code: 'ok', message: '' });
  }
  if (path === '/api/analytics/record-purchase' && req.method === 'POST') {
    if (!ownUser(body.userId)) return fail(res, 400, 'user does not belong to this client');
    if (!body.gateway) return fail(res, 400, 'gateway is required');
    const existing = state.purchases.find((p) => p.orderId === body.orderId && p.gateway === body.gateway);
    if (existing) Object.assign(existing, body);
    else state.purchases.push({ ...body, clientId });
    return sendJson(res, 200, undefined);
  }
  if (path === '/api/analytics/server-events/batch' && req.method === 'POST') {
    const events = body.events ?? [];
    if (events.length > 100) return fail(res, 400, 'at most 100 events per batch');
    const errors = [];
    const forwarded = [];
    events.forEach((event, index) => {
      if (!ownUser(event.userId)) errors.push(`${index}: user ${event.userId} does not belong to this client`);
      else forwarded.push(event);
    });
    const result = ingest(forwarded, 'server');
    return sendJson(res, 200, { accepted: result.accepted, rejected: errors.length + result.errors.length, errors: [...errors, ...result.errors] });
  }
  if (path === '/api/lottery/progress-quest' && req.method === 'POST') {
    if (!ownUser(body.userId)) return fail(res, 400, 'user does not belong to this client');
    state.quests.push(body);
    res.writeHead(204);
    return res.end();
  }
  return fail(res, 404, 'not found');
}

function pay(path, body, req, res) {
  const uid = Number.parseInt(body.uid, 10);
  if (!uid || !body.sku || !PAY_APPS.has(body.pname)) return fail(res, 200, 'no_required_params');
  const find = (status) => state.payments.find((p) => p.pname === body.pname && p.uid === uid && p.sku === body.sku && p.status === status);
  const purchased = find('purchased');
  if (path === '/get_payment') {
    if (!purchased) return fail(res, 200, 'payment_is_not_valid');
    return sendJson(res, 200, {
      uid: purchased.uid,
      sku: purchased.sku,
      token: purchased.token,
      transactionId: purchased.transactionId,
      amount: purchased.amount,
      packageTitle: `Package ${purchased.sku}`,
      gateway: 'zarinpal',
      submittedAt: new Date().toISOString(),
      time: Date.now(),
      success: true,
    });
  }
  if (path === '/verify_payment') {
    // Like Pay: a purchased payment is accepted whatever the token; a payment the gateway did not report
    // back is checked by its token (Pay asks the gateway) and becomes purchased.
    if (purchased) return sendJson(res, 200, { success: true });
    const ready = find('ready');
    if (ready && body.token && ready.token === body.token) {
      ready.status = 'purchased';
      return sendJson(res, 200, { success: true });
    }
    return fail(res, 200, 'payment_is_not_valid');
  }
  if (path === '/consume') {
    if (!purchased) return fail(res, 200, 'payment_is_not_valid');
    purchased.status = 'consumed';
    if (state.dropAfterConsume > 0) {
      state.dropAfterConsume--;
      return req.socket.destroy();
    }
    return sendJson(res, 200, { success: true });
  }
  return fail(res, 404, 'not found');
}

export function startFakeHub(port = 0) {
  state = freshState();
  const server = createServer((req, res) => {
    handle(req, res).catch((error) => {
      console.error(error);
      if (!res.headersSent) fail(res, 500, 'fake hub error');
    });
  });
  return new Promise((resolve) => {
    server.listen(port, '127.0.0.1', () => {
      const { port: actual } = server.address();
      resolve({
        port: actual,
        apiBase: `http://127.0.0.1:${actual}/api`,
        payBase: `http://127.0.0.1:${actual}/pay`,
        close: () => new Promise((done) => server.close(() => done())),
      });
    });
  });
}

export const FAKE_CLIENT = { clientId: 12, clientSecret: 'fake-client-secret-12' };
export const FAKE_OTHER_CLIENT = { clientId: 13, clientSecret: 'fake-client-secret-13' };

// pathToFileURL, not `file://${argv[1]}`: on Windows the script path has a drive letter and backslashes.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const hub = await startFakeHub(Number(process.argv[2] ?? 0));
  console.log(`fake-hub listening on ${hub.port}`);
}
