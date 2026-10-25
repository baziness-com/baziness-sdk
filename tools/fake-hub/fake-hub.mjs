#!/usr/bin/env node
// An in-memory stand-in for the Baziness platform API, implementing the contract the SDKs are
// written against (client auth, v2 users with refresh-token rotation, link codes, coins,
// purchases, analytics). Every SDK's tests run against it, so they all agree on one behaviour.
//
//   node fake-hub.mjs [port]          → prints "fake-hub listening on <port>"
//
// Test control (no auth): POST /__control/reset, POST /__control/fail {path, status, times, error},
// POST /__control/expire-client-tokens, POST /__control/link-code {userId, targetClientId?},
// GET /__control/state.

import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';

const CLIENTS = new Map([
  [12, { secret: 'fake-client-secret-12', name: 'example' }],
  [13, { secret: 'fake-client-secret-13', name: 'other-game' }],
]);
const HUB_CLIENT_ID = 4;
const ACCESS_TOKEN_MS = 15 * 60_000;
const REFRESH_TOKEN_MS = 30 * 86_400_000;
const ROTATION_GRACE_MS = 30_000;
const SERVER_ONLY = new Set(['session_start', 'session_heartbeat', 'session_end', 'device_info', 'iap_purchase_completed', 'auth_login']);
const EVENT_NAME = /^[a-z0-9_:.-]{1,128}$/;

function freshState() {
  return {
    nextUserId: 1000,
    nextAccountId: 1,
    accounts: new Map(), // accountId → { accountId, phone|null }
    users: new Map(), // userId → { userId, clientId, deviceId, platform, store, accountId|null, attribution }
    clientTokens: new Map(), // token → clientId
    accessTokens: new Map(), // token → { userId, expiresAt }
    sessions: new Map(), // sessionId → { userId, current, previous, rotatedAt, revoked, expiresAt }
    refreshIndex: new Map(), // refresh token → sessionId
    linkCodes: new Map(), // code → { userId, expiresAt, consumed, targetClientId }
    coins: new Map(), // userId → balance
    credited: new Set(), // transactionIds
    purchases: [],
    serverEvents: [],
    deviceEvents: [],
    quests: [],
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

function issuePair(userId) {
  const accessToken = jwt({ sub: String(userId), role: 'user', token_use: 'access', exp: Math.floor((Date.now() + ACCESS_TOKEN_MS) / 1000) });
  state.accessTokens.set(accessToken, { userId, expiresAt: Date.now() + ACCESS_TOKEN_MS });
  const refreshToken = token('rt1');
  const sessionId = token('s');
  state.sessions.set(sessionId, { userId, current: refreshToken, previous: null, rotatedAt: 0, revoked: false, expiresAt: Date.now() + REFRESH_TOKEN_MS });
  state.refreshIndex.set(refreshToken, sessionId);
  return pairBody(accessToken, refreshToken);
}

function pairBody(accessToken, refreshToken) {
  return {
    accessToken,
    accessTokenExpiresAt: new Date(state.accessTokens.get(accessToken).expiresAt).toISOString(),
    refreshToken,
    refreshTokenExpiresAt: new Date(Date.now() + REFRESH_TOKEN_MS).toISOString(),
  };
}

function userSession(user) {
  const tokens = issuePair(user.userId);
  return { userId: user.userId, token: tokens.accessToken, isLinkedToAccount: isLinked(user), tokens };
}

const isLinked = (user) => user.accountId !== null && state.accounts.get(user.accountId)?.phone != null;

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
  const access = state.accessTokens.get(value);
  if (!access || access.expiresAt < Date.now()) return null;
  return state.users.get(access.userId) ?? null;
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
  };
  state.users.set(user.userId, user);
  return { user };
}

function refresh(body) {
  const sessionId = state.refreshIndex.get(body.refreshToken ?? '');
  const session = sessionId ? state.sessions.get(sessionId) : null;
  if (!session) return { status: 401, error: 'invalid_refresh_token' };
  if (session.revoked) return { status: 401, error: 'session_revoked' };
  if (session.expiresAt < Date.now()) return { status: 401, error: 'refresh_token_expired' };
  if (body.refreshToken === session.previous) {
    if (Date.now() - session.rotatedAt <= ROTATION_GRACE_MS) return { status: 401, error: 'refresh_token_rotated' };
    session.revoked = true;
    return { status: 401, error: 'refresh_token_reused' };
  }
  const user = state.users.get(session.userId);
  if (user?.suspended) return { status: 403, error: 'account_suspended' };
  const next = token('rt1');
  session.previous = session.current;
  session.current = next;
  session.rotatedAt = Date.now();
  state.refreshIndex.set(next, sessionId);
  const accessToken = jwt({ sub: String(session.userId), role: 'user', token_use: 'access', exp: Math.floor((Date.now() + ACCESS_TOKEN_MS) / 1000) });
  state.accessTokens.set(accessToken, { userId: session.userId, expiresAt: Date.now() + ACCESS_TOKEN_MS });
  return { status: 200, body: { userId: session.userId, isLinkedToAccount: isLinked(user), ...pairBody(accessToken, next) } };
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
  if (path === '/__control/suspend') {
    state.users.get(body.userId).suspended = true;
    return sendJson(res, 200, { ok: true });
  }
  if (path === '/__control/state') {
    return sendJson(res, 200, {
      users: [...state.users.values()],
      purchases: state.purchases,
      serverEvents: state.serverEvents,
      deviceEvents: state.deviceEvents,
      quests: state.quests,
      coins: Object.fromEntries(state.coins),
      requests: state.requests,
      liveSessions: [...state.sessions.values()].filter((s) => !s.revoked).length,
    });
  }

  // ── injected failures ──
  const failure = state.failures.find((f) => f.path === path && f.times > 0);
  if (failure) {
    failure.times--;
    return failure.status === 0 ? req.socket.destroy() : fail(res, failure.status, failure.error ?? 'injected');
  }

  // ── unauthenticated ──
  if (path === '/api/client/auth' && req.method === 'POST') {
    const client = CLIENTS.get(body.clientId);
    if (!client || client.secret !== body.clientSecret) return fail(res, 401, 'invalid client');
    const value = jwt({ sub: String(body.clientId), role: 'client', exp: Math.floor((Date.now() + 3_600_000) / 1000) });
    state.clientTokens.set(value, body.clientId);
    return sendJson(res, 200, { clientId: body.clientId, token: value });
  }
  if (path === '/api/auth/refresh' && req.method === 'POST') {
    const result = refresh(body);
    return result.status === 200 ? sendJson(res, 200, result.body) : fail(res, result.status, result.error);
  }
  if (path === '/api/auth/logout' && req.method === 'POST') {
    const sessionId = state.refreshIndex.get(body.refreshToken ?? '');
    if (sessionId) state.sessions.get(sessionId).revoked = true;
    return sendJson(res, 200, undefined);
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
  if (path === '/api/analytics/attribution' && req.method === 'POST') {
    const user = userOfToken(bearer(req) ?? '');
    if (!user) return fail(res, 401, 'unauthorized');
    if (user.attribution) return sendJson(res, 200, { outcome: 'already_final' });
    user.attribution = body;
    return sendJson(res, 200, { outcome: 'applied' });
  }

  // ── client token ──
  const clientId = clientOf(req);
  if (!clientId) return fail(res, 401, 'unauthorized');
  const ownUser = (userId) => {
    const user = state.users.get(Number(userId));
    return user && user.clientId === clientId ? user : null;
  };

  if (path === '/api/v2/client/create-user' && req.method === 'POST') {
    if (!body.deviceId) return fail(res, 400, 'deviceId is required');
    const result = createUser(clientId, body);
    if (result.error) return fail(res, 400, result.error);
    return sendJson(res, 200, userSession(result.user));
  }
  let match = path.match(/^\/api\/v2\/client\/get-user-token\/(\d+)$/);
  if (match && req.method === 'POST') {
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
    if (state.credited.has(body.transactionId)) return fail(res, 400, 'add resource failed');
    state.credited.add(body.transactionId);
    state.coins.set(user.userId, (state.coins.get(user.userId) ?? 0) + body.amount);
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
        close: () => new Promise((done) => server.close(() => done())),
      });
    });
  });
}

export const FAKE_CLIENT = { clientId: 12, clientSecret: 'fake-client-secret-12' };
export const FAKE_OTHER_CLIENT = { clientId: 13, clientSecret: 'fake-client-secret-13' };

if (import.meta.url === `file://${process.argv[1]}`) {
  const hub = await startFakeHub(Number(process.argv[2] ?? 0));
  console.log(`fake-hub listening on ${hub.port}`);
}
