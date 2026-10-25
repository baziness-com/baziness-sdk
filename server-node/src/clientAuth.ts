import type { Transport } from './http.js';
import type { ClientAuthResponse } from './wire.js';

/** Renew the client token this long before the expiry written in it. */
const RENEW_BEFORE_EXPIRY_MS = 60_000;

/**
 * Step 1 of the flow: the game server proves who it is with its client id and secret and keeps the
 * client token in memory. The token is fetched on first use, renewed shortly before it expires and
 * again whenever a call answers 401. Concurrent callers share one authentication.
 */
export class ClientAuth {
  private token: string | undefined;
  private expiresAt = Number.POSITIVE_INFINITY;
  private inFlight: Promise<string> | undefined;

  constructor(
    private readonly transport: Transport,
    private readonly clientId: number,
    private readonly clientSecret: string,
  ) {}

  async get(deadlineAt: number, forceNew: boolean): Promise<string> {
    if (this.token && !forceNew && Date.now() < this.expiresAt - RENEW_BEFORE_EXPIRY_MS) {
      return this.token;
    }
    this.inFlight ??= this.authenticate(deadlineAt).finally(() => {
      this.inFlight = undefined;
    });
    return this.inFlight;
  }

  private async authenticate(deadlineAt: number): Promise<string> {
    const answer = await this.transport.request<ClientAuthResponse>(
      {
        operation: 'clientAuth',
        method: 'POST',
        path: '/client/auth',
        body: { clientId: this.clientId, clientSecret: this.clientSecret },
        auth: 'none',
        idempotent: true,
      },
      deadlineAt,
    );
    this.token = answer.token;
    this.expiresAt = jwtExpiry(answer.token) ?? Number.POSITIVE_INFINITY;
    return answer.token;
  }
}

/** The `exp` of a JWT in epoch milliseconds, read without verifying it (the platform verifies). */
export function jwtExpiry(token: string): number | undefined {
  const payload = token.split('.')[1];
  if (!payload) return undefined;
  try {
    const claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as { exp?: unknown };
    return typeof claims.exp === 'number' ? claims.exp * 1000 : undefined;
  } catch {
    return undefined;
  }
}
