import { readJson, uuid, type KeyValueStore } from './storage.js';

export type PropValue = string | number | boolean | null | undefined;

export interface TrackOptions {
  value?: number;
  props?: Record<string, PropValue>;
}

export interface DeviceAnalyticsOptions {
  /** Default true. */
  enabled?: boolean;
  /** Send at least this often. Default 30000 ms. */
  flushIntervalMs?: number;
  /** Events kept (persisted) while offline; the oldest are dropped beyond it. Default 1000. */
  maxQueueSize?: number;
}

interface QueuedEvent {
  eventId: string;
  eventKey: string;
  clientTime: string;
  sessionId?: string;
  value?: number;
  props?: Record<string, string>;
}

/**
 * Only the game server may report these (they are refused from devices): sessions, device data,
 * sign-ins and purchases. The device SDK drops them with a warning instead of sending them.
 */
export const SERVER_ONLY_EVENTS: ReadonlySet<string> = new Set([
  'session_start',
  'session_heartbeat',
  'session_end',
  'device_info',
  'iap_purchase_completed',
  'auth_login',
]);
export const EVENT_NAME_PATTERN = /^[a-z0-9_:.-]{1,128}$/;
const MAX_BATCH = 100;
const BACKOFF_MS = [5_000, 30_000, 120_000, 300_000];

export type TokenSource = (force: boolean) => Promise<string>;

/**
 * Player analytics from the device: gameplay, UI and funnel events (`level_complete`,
 * `iap_purchase_started`, `shop:offer:clicked`, …), sent with the player's 15-minute token to
 * `analytics/events/batch`. Queued in storage so a reload or going offline loses nothing; sent every
 * 30 s, at 100 events and when the page is hidden; retried with backoff on 429/5xx/offline.
 */
export class DeviceAnalytics {
  private queue: QueuedEvent[];
  private readonly key: string;
  private readonly enabled: boolean;
  private readonly maxQueueSize: number;
  private timer: ReturnType<typeof setInterval> | undefined;
  private sending: Promise<void> | null = null;
  private retryAt = 0;
  private failures = 0;
  sessionId: string | undefined;
  appVersion: string | undefined;

  constructor(
    private readonly apiBase: string,
    private readonly token: TokenSource,
    private readonly store: KeyValueStore,
    packageName: string,
    private readonly fetchImpl: typeof fetch,
    options: DeviceAnalyticsOptions = {},
  ) {
    this.key = `baziness:events:${packageName}`;
    this.enabled = options.enabled ?? true;
    this.maxQueueSize = options.maxQueueSize ?? 1000;
    this.queue = readJson<QueuedEvent[]>(store, this.key) ?? [];
    if (this.enabled && typeof setInterval !== 'undefined') {
      this.timer = setInterval(() => void this.flush(), options.flushIntervalMs ?? 30_000);
      (this.timer as { unref?: () => void }).unref?.();
    }
  }

  /** Queue one event. Returns false when it was dropped (invalid, server-only or disabled). */
  track(eventKey: string, options: TrackOptions = {}): boolean {
    if (!this.enabled) return false;
    if (!EVENT_NAME_PATTERN.test(eventKey)) {
      console.warn(`[baziness] event "${eventKey}" dropped: name must be 1-128 of a-z 0-9 _ : . -`);
      return false;
    }
    if (SERVER_ONLY_EVENTS.has(eventKey)) {
      console.warn(`[baziness] event "${eventKey}" dropped: only your game server may send it (server SDK)`);
      return false;
    }
    const event: QueuedEvent = { eventId: uuid(), eventKey, clientTime: new Date().toISOString() };
    if (this.sessionId) event.sessionId = this.sessionId;
    if (options.value !== undefined && Number.isFinite(options.value)) event.value = options.value;
    const props = toProps(options.props);
    if (props) event.props = props;
    this.queue.push(event);
    if (this.queue.length > this.maxQueueSize) this.queue.splice(0, this.queue.length - this.maxQueueSize);
    this.persist();
    if (this.queue.length >= MAX_BATCH) void this.flush();
    return true;
  }

  get pending(): number {
    return this.queue.length;
  }

  /** Send what is queued. `keepalive` lets the request finish while the page is being hidden. Never throws. */
  flush(keepalive = false): Promise<void> {
    if (keepalive) this.retryAt = 0;
    this.sending ??= this.drain(keepalive).finally(() => {
      this.sending = null;
    });
    return this.sending;
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  private async drain(keepalive: boolean): Promise<void> {
    while (this.queue.length > 0 && Date.now() >= this.retryAt) {
      const batch = this.queue.slice(0, MAX_BATCH);
      const outcome = await this.send(batch, keepalive);
      if (outcome === 'retry') {
        this.retryAt = Date.now() + (BACKOFF_MS[Math.min(this.failures, BACKOFF_MS.length - 1)] ?? 300_000);
        this.failures++;
        return;
      }
      this.failures = 0;
      this.retryAt = 0;
      const sent = new Set(batch.map((event) => event.eventId));
      this.queue = this.queue.filter((event) => !sent.has(event.eventId));
      this.persist();
    }
  }

  private async send(batch: QueuedEvent[], keepalive: boolean): Promise<'done' | 'retry'> {
    for (let attempt = 0; attempt < 2; attempt++) {
      let token: string;
      try {
        token = await this.token(attempt > 0);
      } catch {
        return 'retry';
      }
      let response: Response;
      try {
        response = await this.fetchImpl(`${this.apiBase}/analytics/events/batch`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
          body: JSON.stringify({ events: batch, sessionId: this.sessionId, appVersion: this.appVersion }),
          keepalive,
        });
      } catch {
        return 'retry'; // offline
      }
      if (response.status === 401) continue; // the token expired: one more try with a new one
      if (response.ok) {
        const answer = (await response.json().catch(() => null)) as { rejected?: number; errors?: string[] } | null;
        if (answer?.rejected) console.warn(`[baziness] ${answer.rejected} event(s) rejected:`, answer.errors);
        return 'done';
      }
      if (response.status === 429 || response.status >= 500) return 'retry';
      console.warn(`[baziness] batch of ${batch.length} dropped: HTTP ${response.status}`);
      return 'done';
    }
    return 'retry';
  }

  private persist(): void {
    if (this.queue.length === 0) this.store.remove(this.key);
    else this.store.set(this.key, JSON.stringify(this.queue));
  }
}

function toProps(props: Record<string, PropValue> | undefined): Record<string, string> | undefined {
  if (!props) return undefined;
  const result: Record<string, string> = {};
  let count = 0;
  for (const [key, raw] of Object.entries(props)) {
    if (raw === undefined || raw === null || raw === '') continue;
    if (count++ >= 32) break;
    result[key.slice(0, 64)] = String(raw).slice(0, 512);
  }
  return count > 0 ? result : undefined;
}
