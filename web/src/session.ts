import type { BackendSession, GameBackend, SessionRequest } from './backend.js';
import type { DeviceInfo } from './device.js';
import type { LaunchParams } from './launch.js';

/** Ask for a new token when the current one has less than this left. */
const RENEW_BEFORE_MS = 60_000;

/**
 * The player's Baziness session on the device: a 15-minute access token from your server, renewed
 * through your server when it is about to expire or a call answers 401. Never stored: a reload asks
 * your server again, which keeps the refresh token.
 */
export class SessionManager {
  private current: BackendSession | null = null;
  private pending: Promise<BackendSession> | null = null;
  private launch: LaunchParams;
  private readonly listeners = new Set<(session: BackendSession | null) => void>();

  constructor(
    private readonly backend: GameBackend,
    private readonly device: DeviceInfo,
    launch: LaunchParams,
  ) {
    this.launch = launch;
  }

  get session(): BackendSession | null {
    return this.current;
  }

  /** A session with at least a minute left; `force` asks your server even when the token looks fine. */
  get(force = false): Promise<BackendSession> {
    if (!force && this.current && expiresIn(this.current) > RENEW_BEFORE_MS) {
      return Promise.resolve(this.current);
    }
    this.pending ??= this.fetch().finally(() => {
      this.pending = null;
    });
    return this.pending;
  }

  async token(force = false): Promise<string> {
    return (await this.get(force)).accessToken;
  }

  /** Forget the session (the page sent `logout`); the next {@link get} starts over. */
  clear(): void {
    this.current = null;
    this.emit();
  }

  onChange(listener: (session: BackendSession | null) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private async fetch(): Promise<BackendSession> {
    const request: SessionRequest = { device: this.device };
    if (this.launch.linkCode) request.linkCode = this.launch.linkCode;
    if (this.launch.attribution) request.attribution = this.launch.attribution;
    // A code works once: even when this request fails, the next one must not send it again.
    this.launch = { ...this.launch, linkCode: null };
    const session = await this.backend.session(request);
    if (!session?.accessToken) throw new Error('Baziness: your server answered /session without an accessToken');
    this.current = session;
    this.emit();
    return session;
  }

  private emit(): void {
    for (const listener of this.listeners) listener(this.current);
  }
}

function expiresIn(session: BackendSession): number {
  const at = Date.parse(session.accessTokenExpiresAt);
  return Number.isFinite(at) ? at - Date.now() : 0;
}
