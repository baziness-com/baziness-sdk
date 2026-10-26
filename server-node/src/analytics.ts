import { createHash, randomUUID } from 'node:crypto';
import { BazinessError } from './errors.js';
import type { Logger, Transport } from './http.js';
import type { DeviceInfo, PaymentGateway } from './types.js';
import type { WireEventBatchResponse, WireServerEvent } from './wire.js';

export interface AnalyticsOptions {
  /** Default true. Off: `track` does nothing (for tests or a game that opts out temporarily). */
  enabled?: boolean;
  /** Send a batch at least this often. Default 5000 ms. */
  flushIntervalMs?: number;
  /** Events per call; the platform accepts at most 100. Default 100. */
  maxBatchSize?: number;
  /** Events kept in memory while the platform is unreachable; the oldest are dropped beyond it. Default 20000. */
  maxQueueSize?: number;
  /** Your game server's version, sent with every event unless the event sets its own. */
  appVersion?: string;
  /** Heartbeat interval of open sessions. Default 60000 ms. */
  heartbeatMs?: number;
  /** An activity session ({@link SessionTracker.touch}) ends after this long without activity. Default 120000 ms. */
  idleTimeoutMs?: number;
}

export type PropValue = string | number | boolean | null | undefined;

/** Where a purchase is paid: a store, your own gateway (`direct`), or Baziness Pay. */
export type FunnelGateway = PaymentGateway | 'baziness_pay';

/** Which ad was shown, as your ad network names it. */
export interface AdPlacement {
  network: string;
  placement: string;
  /** `rewarded`, `interstitial`, `banner`, … */
  format: string;
}

/** @internal */
export interface TrackOptions {
  value?: number;
  props?: Record<string, PropValue>;
  sessionId?: string;
  /**
   * A UUID; keep the same one when you re-send an event yourself so it counts once (see
   * {@link stableEventId}). Generated otherwise. The platform replaces ids that are not UUIDs.
   */
  eventId?: string;
  time?: Date;
  appVersion?: string;
}

/** Same limits as the platform; an event over them is dropped here with a warning. */
export const EVENT_NAME_PATTERN = /^[a-z0-9_:.-]{1,128}$/;
const MAX_PROPS = 32;
const MAX_PROP_KEY = 64;
const MAX_PROP_VALUE = 512;
const BACKOFF_STEPS_MS = [5_000, 30_000, 120_000, 300_000];

/**
 * Trusted analytics: events your game server reports about its own players, sent with the client
 * token to `analytics/server-events/batch`. Sessions, device data, sign-ins and purchases are
 * accepted only through here. Events are batched in memory, sent in the background and retried with
 * backoff while the platform is busy or unreachable; call {@link close} on shutdown to send the rest.
 */
export class ServerAnalytics {
  readonly sessions: SessionTracker;

  private readonly enabled: boolean;
  private readonly flushIntervalMs: number;
  private readonly maxBatchSize: number;
  private readonly maxQueueSize: number;
  private readonly appVersion: string | undefined;
  private queue: WireServerEvent[] = [];
  private timer: NodeJS.Timeout | undefined;
  private flushing: Promise<void> | undefined;
  private retryAt = 0;
  private failures = 0;
  private dropped = 0;
  private closed = false;

  constructor(
    private readonly transport: Transport,
    private readonly logger: Logger,
    options: AnalyticsOptions = {},
  ) {
    this.enabled = options.enabled ?? true;
    this.flushIntervalMs = options.flushIntervalMs ?? 5000;
    this.maxBatchSize = Math.min(100, Math.max(1, options.maxBatchSize ?? 100));
    this.maxQueueSize = options.maxQueueSize ?? 20_000;
    this.appVersion = options.appVersion;
    this.sessions = new SessionTracker(this, options.heartbeatMs ?? 60_000, options.idleTimeoutMs ?? 120_000);
  }

  // ── The events Baziness analytics knows (admin panel: Growth → Events), for results your server
  // decides. Each goes with the player's open session, if any, and returns false when it was
  // dropped (analytics disabled).

  /** The player started a purchase (`iap_purchase_started`). Its completion is `purchases.record`. */
  purchaseStarted(userId: number, purchase: { sku: string; price: number; gateway: FunnelGateway }): boolean {
    return this.game(userId, 'iap_purchase_started', purchase.price, { sku: purchase.sku, gateway: purchase.gateway });
  }

  /** The purchase was cancelled or failed (`iap_purchase_failed`). */
  purchaseFailed(
    userId: number,
    purchase: { sku: string; gateway: FunnelGateway; reason: 'cancelled' | 'error' | 'pending' },
  ): boolean {
    return this.game(userId, 'iap_purchase_failed', undefined, {
      sku: purchase.sku,
      gateway: purchase.gateway,
      reason: purchase.reason,
    });
  }

  /** An ad was shown (`ad_impression`). */
  adImpression(userId: number, ad: AdPlacement): boolean {
    return this.game(userId, 'ad_impression', undefined, { network: ad.network, placement: ad.placement, format: ad.format });
  }

  /** Paid ad revenue for an impression (`ad_revenue`), in Toman, e.g. from your ad network's server callback. */
  adRevenue(userId: number, ad: AdPlacement & { revenue: number }): boolean {
    return this.game(userId, 'ad_revenue', ad.revenue, { network: ad.network, placement: ad.placement, format: ad.format });
  }

  /** Onboarding started (`tutorial_begin`). */
  tutorialBegin(userId: number, step?: string): boolean {
    return this.game(userId, 'tutorial_begin', undefined, { step });
  }

  /** Onboarding finished (`tutorial_complete`). */
  tutorialComplete(userId: number, step?: string): boolean {
    return this.game(userId, 'tutorial_complete', undefined, { step });
  }

  /** A level, match or round started (`level_start`). */
  levelStart(userId: number, level: string | number): boolean {
    return this.game(userId, 'level_start', undefined, { level });
  }

  /** A level, match or round won (`level_complete`). */
  levelComplete(userId: number, result: { level: string | number; score?: number; durationSeconds?: number }): boolean {
    return this.game(userId, 'level_complete', result.score, { level: result.level, duration_s: result.durationSeconds });
  }

  /** A level, match or round lost (`level_fail`). */
  levelFail(
    userId: number,
    result: { level: string | number; score?: number; durationSeconds?: number; reason?: string },
  ): boolean {
    return this.game(userId, 'level_fail', result.score, {
      level: result.level,
      duration_s: result.durationSeconds,
      reason: result.reason,
    });
  }

  /** In-game currency or items gained (`resource_earn`). */
  resourceEarn(userId: number, change: { currency: string; amount: number; item?: string; source?: string }): boolean {
    return this.game(userId, 'resource_earn', change.amount, {
      currency: change.currency,
      item: change.item,
      source: change.source,
    });
  }

  /** In-game currency or items spent (`resource_spend`). */
  resourceSpend(userId: number, change: { currency: string; amount: number; item?: string; sink?: string }): boolean {
    return this.game(userId, 'resource_spend', change.amount, {
      currency: change.currency,
      item: change.item,
      sink: change.sink,
    });
  }

  private game(userId: number, eventKey: string, value: number | undefined, props: Record<string, PropValue>): boolean {
    return this.track(userId, eventKey, { value, props, sessionId: this.sessions.current(userId) });
  }

  /**
   * Queue one event about one of your players: the methods above, and what the SDK sends itself
   * (sessions, sign-ins, purchases). Returns false when it was dropped (invalid or disabled).
   * @internal
   */
  track(userId: number, eventKey: string, options: TrackOptions = {}): boolean {
    if (!this.enabled || this.closed) return false;
    const problem = validate(userId, eventKey, options.value);
    if (problem) {
      this.logger.warn(`[baziness] analytics event "${eventKey}" dropped: ${problem}`);
      return false;
    }
    const event: WireServerEvent = {
      eventId: options.eventId ?? randomUUID(),
      eventKey,
      userId,
      clientTime: (options.time ?? new Date()).toISOString(),
    };
    if (options.sessionId) event.sessionId = options.sessionId;
    const appVersion = options.appVersion ?? this.appVersion;
    if (appVersion) event.appVersion = appVersion;
    if (options.value !== undefined) event.value = options.value;
    const props = toProps(options.props);
    if (props) event.props = props;

    this.queue.push(event);
    if (this.queue.length > this.maxQueueSize) {
      this.queue.shift();
      if (this.dropped++ % 1000 === 0) {
        this.logger.warn(`[baziness] analytics queue full; dropped ${this.dropped} oldest event(s) so far`);
      }
    }
    this.ensureTimer();
    if (this.queue.length >= this.maxBatchSize) void this.flush();
    return true;
  }

  /** Send everything queued now (one batch after another). Never throws. */
  flush(): Promise<void> {
    this.flushing ??= this.drain().finally(() => {
      this.flushing = undefined;
    });
    return this.flushing;
  }

  /** End open sessions, stop the timer and send what is left, waiting at most `timeoutMs`. */
  async close(timeoutMs = 5000): Promise<void> {
    this.sessions.endAll('shutdown');
    this.closed = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    this.retryAt = 0;
    await Promise.race([this.flush(), new Promise((resolve) => setTimeout(resolve, timeoutMs).unref())]);
  }

  /** Events waiting to be sent. */
  get pending(): number {
    return this.queue.length;
  }

  private ensureTimer(): void {
    if (this.timer || this.closed) return;
    this.timer = setInterval(() => void this.flush(), this.flushIntervalMs);
    this.timer.unref();
  }

  private async drain(): Promise<void> {
    while (this.queue.length > 0 && Date.now() >= this.retryAt) {
      const batch = this.queue.slice(0, this.maxBatchSize);
      const outcome = await this.send(batch);
      if (outcome === 'retry') {
        this.retryAt = Date.now() + (BACKOFF_STEPS_MS[Math.min(this.failures, BACKOFF_STEPS_MS.length - 1)] ?? 300_000);
        this.failures++;
        return;
      }
      this.failures = 0;
      this.retryAt = 0;
      // Only now: events tracked while the batch was in flight stay queued behind it.
      this.queue.splice(0, batch.length);
    }
  }

  private async send(batch: WireServerEvent[]): Promise<'done' | 'retry'> {
    try {
      const answer = await this.transport.request<WireEventBatchResponse>({
        operation: 'serverEvents',
        method: 'POST',
        path: '/analytics/server-events/batch',
        body: { events: batch },
        auth: 'client',
        // Every event carries its id, so a batch sent twice counts once.
        idempotent: true,
      });
      if (answer?.rejected) {
        this.logger.warn(`[baziness] analytics: ${answer.rejected} event(s) rejected: ${answer.errors.slice(0, 5).join('; ')}`);
      }
      return 'done';
    } catch (error) {
      if (error instanceof BazinessError && error.status !== undefined && error.status >= 400 && error.status < 500
          && error.status !== 429 && error.status !== 401) {
        // The batch itself is wrong; sending it again cannot help.
        this.logger.error(`[baziness] analytics: batch of ${batch.length} dropped: ${error.message}`);
        return 'done';
      }
      this.logger.warn(`[baziness] analytics: ${(error as Error).message}; ${this.queue.length} event(s) kept for later`);
      return 'retry';
    }
  }
}

export interface SessionStartOptions {
  /** Your own session id; a UUID is generated otherwise. */
  sessionId?: string;
  /** Why it started: `connect`, `cold_start`, `resume`, … Default `connect`. */
  reason?: string;
  /** From the device SDK; sent once per session as `device_info`. */
  device?: DeviceInfo;
  appVersion?: string;
}

interface OpenSession {
  id: string;
  startedAt: number;
  lastSeen: number;
  lastHeartbeat: number;
  appVersion: string | undefined;
  /** `activity`: ended by the idle timeout; `explicit`: ended by {@link SessionTracker.end}. */
  mode: 'activity' | 'explicit';
}

/**
 * Player sessions as the game server sees them. Socket servers call {@link start} on connect and
 * {@link end} on disconnect; request/response servers call {@link touch} on every authenticated
 * request and let the idle timeout end the session. Both send `session_start`, a
 * `session_heartbeat` every minute (value = seconds so far) and `session_end` (value = length).
 */
export class SessionTracker {
  private readonly open = new Map<number, OpenSession>();
  private timer: NodeJS.Timeout | undefined;

  constructor(
    private readonly analytics: ServerAnalytics,
    private readonly heartbeatMs: number,
    private readonly idleTimeoutMs: number,
  ) {}

  /** Start a session (ending the player's open one first). Returns the session id. */
  start(userId: number, options: SessionStartOptions = {}): string {
    this.end(userId, 'replaced');
    const now = Date.now();
    const session: OpenSession = {
      id: options.sessionId ?? randomUUID(),
      startedAt: now,
      lastSeen: now,
      lastHeartbeat: now,
      appVersion: options.appVersion ?? options.device?.appVersion,
      mode: 'explicit',
    };
    this.open.set(userId, session);
    this.emit(userId, session, 'session_start', undefined, { reason: options.reason ?? 'connect' });
    if (options.device) {
      this.emit(userId, session, 'device_info', undefined, deviceProps(options.device));
    }
    this.ensureTimer();
    return session.id;
  }

  /**
   * The player's open session, or a new one (connection-based servers: call it from the device's
   * session request, which repeats on every token renewal). Returns the session id.
   */
  ensure(userId: number, options: SessionStartOptions = {}): string {
    return this.open.get(userId)?.id ?? this.start(userId, options);
  }

  /** Record activity; starts an activity session when the player has none. Returns the session id. */
  touch(userId: number, options: Omit<SessionStartOptions, 'reason'> = {}): string {
    const session = this.open.get(userId);
    if (session) {
      session.lastSeen = Date.now();
      return session.id;
    }
    const id = this.start(userId, { ...options, reason: 'activity' });
    this.open.get(userId)!.mode = 'activity';
    return id;
  }

  /** End the player's open session, if any. */
  end(userId: number, reason = 'disconnect'): void {
    const session = this.open.get(userId);
    if (!session) return;
    this.open.delete(userId);
    const endedAt = session.mode === 'activity' ? session.lastSeen : Date.now();
    this.emit(userId, session, 'session_end', seconds(endedAt - session.startedAt), { reason }, new Date(endedAt));
  }

  /** The player's open session id, if any. */
  current(userId: number): string | undefined {
    return this.open.get(userId)?.id;
  }

  endAll(reason: string): void {
    for (const userId of [...this.open.keys()]) this.end(userId, reason);
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  private ensureTimer(): void {
    if (this.timer) return;
    this.timer = setInterval(() => this.tick(), Math.min(this.heartbeatMs, 15_000));
    this.timer.unref();
  }

  private tick(): void {
    const now = Date.now();
    for (const [userId, session] of this.open) {
      if (session.mode === 'activity' && now - session.lastSeen > this.idleTimeoutMs) {
        this.end(userId, 'idle');
        continue;
      }
      if (now - session.lastHeartbeat >= this.heartbeatMs) {
        session.lastHeartbeat = now;
        const activeUntil = session.mode === 'activity' ? session.lastSeen : now;
        this.emit(userId, session, 'session_heartbeat', seconds(activeUntil - session.startedAt));
      }
    }
    if (this.open.size === 0 && this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  private emit(
    userId: number,
    session: OpenSession,
    eventKey: string,
    value?: number,
    props?: Record<string, PropValue>,
    time?: Date,
  ): void {
    const options: TrackOptions = { sessionId: session.id };
    if (value !== undefined) options.value = value;
    if (props) options.props = props;
    if (time) options.time = time;
    if (session.appVersion) options.appVersion = session.appVersion;
    this.analytics.track(userId, eventKey, options);
  }
}

/** A UUID derived from `key` (name-based, SHA-1), for events that must count once however often they are sent. */
export function stableEventId(key: string): string {
  const bytes = createHash('sha1').update(`baziness:${key}`).digest().subarray(0, 16);
  bytes[6] = (bytes[6]! & 0x0f) | 0x50;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** Device fields as `device_info` props (snake_case strings). */
export function deviceProps(device: DeviceInfo): Record<string, PropValue> {
  return {
    device_id: device.deviceId,
    platform: device.platform,
    store: device.store,
    model: device.model,
    manufacturer: device.manufacturer,
    device_type: device.deviceType,
    os: device.os,
    os_version: device.osVersion,
    app_version: device.appVersion,
    sdk: device.sdk,
    sdk_version: device.sdkVersion,
    locale: device.locale,
    timezone: device.timezone,
    screen: device.screenWidth && device.screenHeight ? `${device.screenWidth}x${device.screenHeight}` : undefined,
    dpi: device.dpi,
    memory_mb: device.memoryMb,
    browser: device.browser,
    installer: device.installer,
    network: device.network,
  };
}

function seconds(ms: number): number {
  return Math.max(0, Math.round(ms / 1000));
}

function validate(userId: number, eventKey: string, value: number | undefined): string | undefined {
  if (!Number.isSafeInteger(userId) || userId <= 0) return 'userId must be a Baziness user id';
  if (!EVENT_NAME_PATTERN.test(eventKey)) return 'name must be 1-128 of a-z 0-9 _ : . -';
  if (value !== undefined && !Number.isFinite(value)) return 'value must be a finite number';
  return undefined;
}

function toProps(props: Record<string, PropValue> | undefined): Record<string, string> | undefined {
  if (!props) return undefined;
  const result: Record<string, string> = {};
  let count = 0;
  for (const [key, raw] of Object.entries(props)) {
    if (raw === undefined || raw === null || raw === '') continue;
    if (count++ >= MAX_PROPS) break;
    result[key.slice(0, MAX_PROP_KEY)] = String(raw).slice(0, MAX_PROP_VALUE);
  }
  return count > 0 ? result : undefined;
}
