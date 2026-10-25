import { BazinessError } from './errors.js';

export interface Logger {
  info(message: string, ...meta: unknown[]): void;
  warn(message: string, ...meta: unknown[]): void;
  error(message: string, ...meta: unknown[]): void;
}

/** A logger that says nothing; pass `console` (or your own) to see what the SDK does. */
export const silentLogger: Logger = { info() {}, warn() {}, error() {} };

export interface HttpOptions {
  /** Timeout of one attempt, headers and body included. Default 8000 ms. */
  timeoutMs?: number;
  /**
   * Ceiling for one logical call: every attempt, backoff, the wait for a free slot and the 401
   * re-authentication. Most calls sit on a player-facing request, so the useful question is whether
   * the answer came before the player gave up. Default 15000 ms.
   */
  deadlineMs?: number;
  /** Attempts for failures worth retrying. Default 3. */
  maxAttempts?: number;
  /** First backoff; it doubles per attempt, with jitter. Default 300 ms. */
  retryBaseMs?: number;
  /** Requests in flight at once; a slow platform then fails fast instead of piling up. Default 32, 0 = no limit. */
  maxConcurrent?: number;
  /** Consecutive "platform unavailable" failures of one operation that open its breaker. Default 8, 0 = off. */
  breakerThreshold?: number;
  /** How long an open breaker fails calls at once before letting one probe through. Default 15000 ms. */
  breakerResetMs?: number;
}

export type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

export interface RequestSpec {
  /** Name used in errors, logs and the circuit breaker, e.g. `addCoin`. */
  operation: string;
  method: 'GET' | 'POST';
  /** Path under the API root, e.g. `/client/add-coin`. */
  path: string;
  body?: unknown;
  /** `client`: send the client token (and re-authenticate once on 401). */
  auth: 'client' | 'none';
  /**
   * Safe to send twice. Idempotent calls are retried after timeouts and 500s; the others only when
   * the platform certainly did not process them (429, 502, 503, connection refused).
   */
  idempotent: boolean;
  /** Parse the body as JSON. Default true. */
  expectJson?: boolean;
}

/** Supplies the client token; `forceNew` after a 401. Set by {@link ClientAuth}. */
export type ClientTokenSupplier = (deadlineAt: number, forceNew: boolean) => Promise<string>;

interface Answer {
  status: number;
  text: string;
  retryAfterMs: number | undefined;
}

const RETRYABLE_ALWAYS = new Set([429, 502, 503]);
const RETRYABLE_IF_IDEMPOTENT = new Set([500, 504]);
// The request never left this machine, so even a non-idempotent call is safe to send again.
const NOT_SENT_CODES = new Set(['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN']);

/**
 * The SDK's only way to the platform: timeouts, a deadline per call, bounded retries, a concurrency
 * limit, a breaker per operation and the client-token 401 dance.
 */
export class Transport {
  private readonly timeoutMs: number;
  private readonly deadlineMs: number;
  private readonly maxAttempts: number;
  private readonly retryBaseMs: number;
  private readonly slots: Slots;
  private readonly breaker: Breaker;
  private clientToken: ClientTokenSupplier | undefined;

  constructor(
    private readonly apiBase: string,
    options: HttpOptions,
    private readonly fetchImpl: FetchLike,
    private readonly logger: Logger,
  ) {
    this.timeoutMs = options.timeoutMs ?? 8000;
    this.deadlineMs = options.deadlineMs ?? 15000;
    this.maxAttempts = Math.max(1, options.maxAttempts ?? 3);
    this.retryBaseMs = options.retryBaseMs ?? 300;
    this.slots = new Slots(options.maxConcurrent ?? 32);
    this.breaker = new Breaker(options.breakerThreshold ?? 8, options.breakerResetMs ?? 15000);
  }

  useClientToken(supplier: ClientTokenSupplier): void {
    this.clientToken = supplier;
  }

  async request<T>(spec: RequestSpec, deadlineAt = Date.now() + this.deadlineMs): Promise<T> {
    if (this.breaker.isOpen(spec.operation)) {
      throw new BazinessError(`${spec.operation}: platform unavailable (circuit open)`, spec.operation);
    }
    try {
      const result = await this.requestWithAuth<T>(spec, deadlineAt);
      this.breaker.succeeded(spec.operation);
      return result;
    } catch (error) {
      if (error instanceof BazinessError && error.isUnavailable && this.breaker.failed(spec.operation)) {
        this.logger.warn(`[baziness] ${spec.operation}: circuit opened after repeated failures`);
      }
      throw error;
    }
  }

  private async requestWithAuth<T>(spec: RequestSpec, deadlineAt: number): Promise<T> {
    if (spec.auth === 'none') {
      return this.parse<T>(spec, await this.withRetries(spec, deadlineAt, undefined));
    }
    if (!this.clientToken) {
      throw new Error('Transport: no client token supplier');
    }
    let token = await this.clientToken(deadlineAt, false);
    let answer = await this.withRetries(spec, deadlineAt, token);
    if (answer.status === 401) {
      // The client token expired or was revoked: authenticate again and retry this call once.
      token = await this.clientToken(deadlineAt, true);
      answer = await this.withRetries(spec, deadlineAt, token);
    }
    return this.parse<T>(spec, answer);
  }

  private parse<T>(spec: RequestSpec, answer: Answer): T {
    if (answer.status >= 200 && answer.status < 300) {
      if (spec.expectJson === false || answer.text.trim() === '') {
        return undefined as T;
      }
      try {
        return JSON.parse(answer.text) as T;
      } catch {
        throw new BazinessError(`${spec.operation}: the platform sent invalid JSON`, spec.operation, answer.status);
      }
    }
    const code = errorCode(answer.text);
    throw new BazinessError(
      `${spec.operation}: HTTP ${answer.status}${code ? ` (${code})` : ''}`,
      spec.operation,
      answer.status,
      code,
    );
  }

  private async withRetries(spec: RequestSpec, deadlineAt: number, token: string | undefined): Promise<Answer> {
    let lastError: BazinessError | undefined;
    for (let attempt = 1; attempt <= this.maxAttempts; attempt++) {
      let retryAfterMs: number | undefined;
      try {
        const answer = await this.once(spec, deadlineAt, token);
        const retryable =
          RETRYABLE_ALWAYS.has(answer.status) || (spec.idempotent && RETRYABLE_IF_IDEMPOTENT.has(answer.status));
        if (!retryable || attempt === this.maxAttempts) {
          return answer;
        }
        retryAfterMs = answer.retryAfterMs;
        lastError = new BazinessError(`${spec.operation}: HTTP ${answer.status}`, spec.operation, answer.status);
      } catch (error) {
        lastError = toTransportError(spec.operation, error);
        const notSent = NOT_SENT_CODES.has(causeCode(error) ?? '');
        if (!(spec.idempotent || notSent) || attempt === this.maxAttempts) {
          throw lastError;
        }
      }
      const backoff = retryAfterMs ?? this.retryBaseMs * 2 ** (attempt - 1) * (0.5 + Math.random());
      if (Date.now() + backoff >= deadlineAt) {
        throw lastError;
      }
      this.logger.warn(`[baziness] ${spec.operation}: ${lastError.message}; retrying in ${Math.round(backoff)} ms`);
      await sleep(backoff);
    }
    throw lastError ?? new BazinessError(`${spec.operation}: failed`, spec.operation);
  }

  private async once(spec: RequestSpec, deadlineAt: number, token: string | undefined): Promise<Answer> {
    if (!(await this.slots.acquire(deadlineAt))) {
      throw new BazinessError(`${spec.operation}: too many requests in flight`, spec.operation);
    }
    const remaining = deadlineAt - Date.now();
    if (remaining <= 0) {
      this.slots.release();
      throw new BazinessError(`${spec.operation}: deadline exceeded`, spec.operation);
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), Math.min(this.timeoutMs, remaining));
    timer.unref?.();
    try {
      const headers: Record<string, string> = { Accept: 'application/json' };
      if (spec.body !== undefined) headers['Content-Type'] = 'application/json';
      if (token) headers.Authorization = `Bearer ${token}`;
      const response = await this.fetchImpl(`${this.apiBase}${spec.path}`, {
        method: spec.method,
        headers,
        body: spec.body === undefined ? undefined : JSON.stringify(spec.body),
        signal: controller.signal,
      });
      const text = await response.text();
      return { status: response.status, text, retryAfterMs: retryAfter(response.headers.get('retry-after')) };
    } finally {
      clearTimeout(timer);
      this.slots.release();
    }
  }
}

function errorCode(text: string): string | undefined {
  if (!text) return undefined;
  try {
    const body = JSON.parse(text) as { error?: unknown; title?: unknown; message?: unknown };
    for (const candidate of [body.error, body.message, body.title]) {
      if (typeof candidate === 'string' && candidate.trim()) return candidate.trim();
    }
  } catch {
    // Not JSON: a short plain-text body is the reason itself.
    if (text.length <= 200) return text.trim() || undefined;
  }
  return undefined;
}

function retryAfter(header: string | null): number | undefined {
  if (!header) return undefined;
  const seconds = Number(header);
  return Number.isFinite(seconds) && seconds >= 0 ? Math.min(seconds * 1000, 30_000) : undefined;
}

function causeCode(error: unknown): string | undefined {
  const cause = (error as { cause?: { code?: unknown } } | undefined)?.cause;
  return typeof cause?.code === 'string' ? cause.code : undefined;
}

function toTransportError(operation: string, error: unknown): BazinessError {
  if (error instanceof BazinessError) return error;
  const aborted = (error as { name?: string } | undefined)?.name === 'AbortError';
  const reason = aborted ? 'timed out' : `network error (${causeCode(error) ?? (error as Error)?.message ?? 'unknown'})`;
  return new BazinessError(`${operation}: ${reason}`, operation);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Bounds requests in flight; a caller waits for a slot only until its deadline. */
class Slots {
  private active = 0;
  private readonly waiting: Array<() => void> = [];

  constructor(private readonly limit: number) {}

  async acquire(deadlineAt: number): Promise<boolean> {
    if (this.limit <= 0) return true;
    if (this.active < this.limit) {
      this.active++;
      return true;
    }
    return new Promise<boolean>((resolve) => {
      const admit = (): void => {
        clearTimeout(timer);
        this.active++;
        resolve(true);
      };
      const timer = setTimeout(() => {
        const index = this.waiting.indexOf(admit);
        if (index >= 0) this.waiting.splice(index, 1);
        resolve(false);
      }, Math.max(0, deadlineAt - Date.now()));
      timer.unref?.();
      this.waiting.push(admit);
    });
  }

  release(): void {
    if (this.limit <= 0) return;
    this.active--;
    this.waiting.shift()?.();
  }
}

/** Per-operation breaker: a degraded `getCoin` never blocks `createUser`. */
class Breaker {
  private readonly failures = new Map<string, number>();
  private readonly openedAt = new Map<string, number>();

  constructor(
    private readonly threshold: number,
    private readonly resetMs: number,
  ) {}

  isOpen(operation: string): boolean {
    if (this.threshold <= 0) return false;
    const openedAt = this.openedAt.get(operation);
    if (openedAt === undefined) return false;
    if (Date.now() - openedAt < this.resetMs) return true;
    // Half-open: this call is the probe; one more failure re-opens the breaker.
    this.openedAt.delete(operation);
    this.failures.set(operation, this.threshold - 1);
    return false;
  }

  succeeded(operation: string): void {
    this.failures.delete(operation);
    this.openedAt.delete(operation);
  }

  /** True when this failure opened the breaker. */
  failed(operation: string): boolean {
    if (this.threshold <= 0) return false;
    const failures = (this.failures.get(operation) ?? 0) + 1;
    this.failures.set(operation, failures);
    if (failures < this.threshold || this.openedAt.has(operation)) return false;
    this.openedAt.set(operation, Date.now());
    this.failures.set(operation, 0);
    return true;
  }
}
