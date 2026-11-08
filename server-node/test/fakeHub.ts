import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { BazinessServer, type BazinessServerOptions } from '../src/index.js';

export interface FakeHub {
  port: number;
  apiBase: string;
  payBase: string;
  close(): Promise<void>;
}

interface FakeHubModule {
  startFakeHub(port?: number): Promise<FakeHub>;
  FAKE_CLIENT: { clientId: number; clientSecret: string };
  FAKE_OTHER_CLIENT: { clientId: number; clientSecret: string };
}

// npm test runs from server-node/; the fake hub is shared by every SDK in this repo.
const modulePath = pathToFileURL(resolve(process.cwd(), '../tools/fake-hub/fake-hub.mjs')).href;
export const fake = (await import(modulePath)) as FakeHubModule;

export async function control<T = unknown>(hub: FakeHub, path: string, body?: unknown): Promise<T> {
  const response = await fetch(`http://127.0.0.1:${hub.port}/__control/${path}`, {
    method: body === undefined && path === 'state' ? 'GET' : 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return (await response.json()) as T;
}

export interface HubState {
  users: Array<{ userId: number; clientId: number; deviceId: string; accountId: number | null; attribution: unknown }>;
  purchases: Array<Record<string, unknown>>;
  serverEvents: Array<{ eventId: string; eventKey: string; userId: number; sessionId?: string; value?: number; props?: Record<string, string> }>;
  deviceEvents: unknown[];
  quests: unknown[];
  adEvents: Array<{ adId: number; userId: number; eventType: string; clientId: number }>;
  payments: Array<{ pname: string; uid: number; sku: string; token: string; status: string }>;
  coins: Record<string, number>;
  requests: Array<{ method: string; path: string }>;
  fingerprints: Array<{ userId: number; via: 'device' | 'server'; ip?: string; userAgent?: string; deviceModel?: string; osVersion?: string }>;
}

/** An SDK on the fake hub. */
export function sdk(hub: FakeHub, overrides: Partial<BazinessServerOptions> = {}) {
  const baziness = new BazinessServer({
    environment: 'staging',
    ...fake.FAKE_CLIENT,
    apiBaseUrl: hub.apiBase,
    payBaseUrl: hub.payBase,
    http: { retryBaseMs: 10, deadlineMs: 5000 },
    analytics: { flushIntervalMs: 60_000 },
    ...overrides,
  });
  return { baziness };
}

