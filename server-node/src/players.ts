import type { ServerAnalytics } from './analytics.js';
import { BazinessError, ErrorCodes } from './errors.js';
import type { Logger, Transport } from './http.js';
import type {
  Attribution,
  Platform,
  PlayerSession,
  RefreshTokenStore,
  SignInMethod,
  SignInResult,
  Store,
} from './types.js';
import type {
  WireAccountData,
  WireAttribution,
  WireLinkCode,
  WireRefreshResponse,
  WireUserSession,
  WireValidateToken,
} from './wire.js';

export interface CreatePlayerInput {
  /** Your stable id for this install (the device id your game generated on first launch). */
  deviceId: string;
  platform: Platform;
  store: Store;
  /** One-time code the player arrived with (`?linkCode=` / deep link): joins them to that person. */
  linkCode?: string | null;
  /** First-open attribution from the device SDK. */
  attribution?: Attribution | null;
}

export interface SignInInput extends CreatePlayerInput {
  /** The Baziness user id you already saved for this player, if any. */
  userId?: number | null;
}

/** A session including its refresh token: only the low-level calls return it. */
export interface SessionWithRefreshToken extends PlayerSession {
  refreshToken: string;
  refreshTokenExpiresAt: string;
}

export interface LinkCode {
  /** Put it on the page address as `linkCode=`. Works once, for about two minutes. */
  code: string;
  expiresAt: string;
}

export interface VerifiedToken {
  valid: boolean;
  /** The Baziness user the token belongs to; 0 when not valid. */
  userId: number;
}

export interface AccountData {
  accountId: number;
  phoneNumber: string;
  fullName: string;
  nationalCode: string;
  isActive: boolean;
}

const SESSION_OVER = new Set<string>([
  ErrorCodes.sessionRevoked,
  ErrorCodes.refreshTokenExpired,
  ErrorCodes.invalidRefreshToken,
  ErrorCodes.refreshTokenReused,
]);
/** Hand a cached access token out only while it has at least this long left. */
const MIN_TOKEN_LIFE_MS = 60_000;
const MAX_CACHED_SESSIONS = 10_000;

/**
 * Steps 2 and 3 of the flow: Baziness users for your players, their sessions (15-minute access
 * tokens renewed with refresh tokens kept on your server), link codes for Baziness pages, and
 * verifying tokens that come back from a page.
 */
export class Players {
  private readonly cache = new Map<number, PlayerSession>();
  private readonly inFlight = new Map<number, Promise<SignInResult>>();

  constructor(
    private readonly transport: Transport,
    private readonly store: RefreshTokenStore | undefined,
    private readonly analytics: ServerAnalytics,
    private readonly logger: Logger,
  ) {}

  // ── High level: what a game server calls ────────────────────────────────────

  /**
   * The one call for "a player's device came online". Creates the Baziness user the first time (or
   * when the player arrived with a link code), otherwise renews their session. Saves the newest
   * refresh token in your store and reports `auth_login`.
   *
   * Compare the returned `userId` with the one you saved: when it belongs to **another** of your
   * players, it is the same person on another device — switch this device to that player.
   */
  async signIn(input: SignInInput): Promise<SignInResult> {
    const store = this.requireStore();
    let linkCodeRejected = false;
    if (input.linkCode || !input.userId) {
      try {
        const session = await this.create(input);
        return await this.keep(store, session, input.linkCode ? 'link_code' : 'created', false);
      } catch (error) {
        if (!(input.linkCode && isCode(error, ErrorCodes.invalidLinkCode))) throw error;
        // Expired, already used or meant for another game: carry on as if no code was sent.
        linkCodeRejected = true;
        this.logger.info('[baziness] link code rejected; continuing without it');
      }
      if (!input.userId) {
        const session = await this.create({ ...input, linkCode: null });
        return this.keep(store, session, 'created', true);
      }
    }
    const result = await this.session(input.userId);
    return { ...result, linkCodeRejected };
  }

  /**
   * A valid access token for a known player: the cached one while it has a minute left, otherwise a
   * refresh (one at a time per player). Falls back to a new session when the refresh token is
   * missing or the session ended. Throws {@link BazinessError} `account_suspended` (403) for a blocked
   * account.
   */
  async session(userId: number): Promise<SignInResult> {
    const cached = this.cache.get(userId);
    if (cached && Date.parse(cached.accessTokenExpiresAt) - Date.now() > MIN_TOKEN_LIFE_MS) {
      return { ...cached, method: 'refresh', linkCodeRejected: false };
    }
    let pending = this.inFlight.get(userId);
    if (!pending) {
      pending = this.renew(userId).finally(() => this.inFlight.delete(userId));
      this.inFlight.set(userId, pending);
    }
    return pending;
  }

  /** A link code for opening a Baziness page as this player. Get a new one for every page. */
  async linkCode(userId: number): Promise<LinkCode> {
    const answer = await this.transport.request<WireLinkCode>({
      operation: 'linkCode',
      method: 'POST',
      path: `/v2/client/link-code/${userId}`,
      auth: 'client',
      idempotent: true,
    });
    return { code: answer.code, expiresAt: answer.expiresAt };
  }

  /**
   * Check a token that came from a device (the `login` message of a Baziness page) before acting on
   * it. Invalid or expired tokens give `{ valid: false, userId: 0 }`, not an error.
   */
  async verifyToken(token: string): Promise<VerifiedToken> {
    const answer = await this.transport.request<WireValidateToken>({
      operation: 'verifyToken',
      method: 'POST',
      path: '/client/validate-user-token',
      body: { token },
      auth: 'client',
      idempotent: true,
    });
    return { valid: Boolean(answer.isValid) && answer.userId > 0, userId: answer.isValid ? answer.userId : 0 };
  }

  /** End the player's session (the page sent `logout`) and forget their refresh token. */
  async logout(userId: number): Promise<void> {
    const store = this.requireStore();
    this.cache.delete(userId);
    const refreshToken = await store.get(userId);
    if (refreshToken) {
      await this.revoke(refreshToken).catch((error: unknown) =>
        this.logger.warn(`[baziness] logout: ${(error as Error).message}`),
      );
    }
    await store.set(userId, null);
  }

  /** The player's Baziness account (phone, name), or null when they have not signed in. */
  async accountData(userId: number): Promise<AccountData | null> {
    const answer = await this.transport.request<WireAccountData | null>({
      operation: 'accountData',
      method: 'GET',
      path: `/client/account-data/${userId}`,
      auth: 'client',
      idempotent: true,
    });
    return answer ?? null;
  }

  // ── Low level: one platform call each; you keep the refresh token yourself ───

  /** `v2/client/create-user`. */
  async create(input: CreatePlayerInput): Promise<SessionWithRefreshToken> {
    const answer = await this.transport.request<WireUserSession>({
      operation: 'createUser',
      method: 'POST',
      path: '/v2/client/create-user',
      body: {
        deviceId: input.deviceId,
        platform: input.platform,
        store: input.store,
        linkCode: input.linkCode || null,
        attribution: toWireAttribution(input.attribution),
      },
      auth: 'client',
      // A retried create could consume the link code twice or create a second user.
      idempotent: false,
    });
    return fromUserSession(answer);
  }

  /** `v2/client/get-user-token/{id}`: a new session for a known player. */
  async newSession(userId: number): Promise<SessionWithRefreshToken> {
    const answer = await this.transport.request<WireUserSession>({
      operation: 'newSession',
      method: 'POST',
      path: `/v2/client/get-user-token/${userId}`,
      auth: 'client',
      idempotent: false,
    });
    return fromUserSession(answer);
  }

  /** `auth/refresh`: renews a session. The old refresh token stops working; keep the new one. */
  async refresh(refreshToken: string): Promise<SessionWithRefreshToken> {
    const answer = await this.transport.request<WireRefreshResponse>({
      operation: 'refresh',
      method: 'POST',
      path: '/auth/refresh',
      body: { refreshToken },
      auth: 'none',
      idempotent: false,
    });
    return {
      userId: answer.userId,
      isLinkedToAccount: answer.isLinkedToAccount,
      accessToken: answer.accessToken,
      accessTokenExpiresAt: answer.accessTokenExpiresAt,
      refreshToken: answer.refreshToken,
      refreshTokenExpiresAt: answer.refreshTokenExpiresAt,
    };
  }

  /** `auth/logout`: ends the session of this refresh token. */
  async revoke(refreshToken: string): Promise<void> {
    await this.transport.request<void>({
      operation: 'logout',
      method: 'POST',
      path: '/auth/logout',
      body: { refreshToken },
      auth: 'none',
      idempotent: true,
      expectJson: false,
    });
  }

  // ── Internals ─────────────────────────────────────────────────────────────────

  private async renew(userId: number): Promise<SignInResult> {
    const store = this.requireStore();
    const saved = await store.get(userId);
    if (saved) {
      const refreshed = await this.tryRefresh(store, userId, saved);
      if (refreshed) return this.keep(store, refreshed, 'refresh', false);
    }
    // No refresh token yet (a player from before the migration) or the session ended.
    return this.keep(store, await this.newSession(userId), 'new_session', false);
  }

  private async tryRefresh(
    store: RefreshTokenStore,
    userId: number,
    refreshToken: string,
  ): Promise<SessionWithRefreshToken | undefined> {
    try {
      return await this.refresh(refreshToken);
    } catch (error) {
      if (isCode(error, ErrorCodes.refreshTokenRotated)) {
        // Another server instance refreshed this player a moment ago: wait for it to save the
        // newest token, then renew with that one.
        for (let attempt = 1; attempt <= 3; attempt++) {
          await new Promise((resolve) => setTimeout(resolve, 150 * attempt));
          const latest = await store.get(userId);
          if (latest && latest !== refreshToken) {
            return this.refresh(latest).catch((retryError: unknown) => {
              if (sessionOver(retryError) || isCode(retryError, ErrorCodes.refreshTokenRotated)) return undefined;
              throw retryError;
            });
          }
        }
        return undefined;
      }
      if (sessionOver(error)) return undefined;
      throw error;
    }
  }

  private async keep(
    store: RefreshTokenStore,
    session: SessionWithRefreshToken,
    method: SignInMethod,
    linkCodeRejected: boolean,
  ): Promise<SignInResult> {
    // Always the newest refresh token: the previous one stops working.
    await store.set(session.userId, session.refreshToken);
    const result: PlayerSession = {
      userId: session.userId,
      isLinkedToAccount: session.isLinkedToAccount,
      accessToken: session.accessToken,
      accessTokenExpiresAt: session.accessTokenExpiresAt,
    };
    this.remember(result);
    if (method !== 'refresh') {
      this.analytics.track(session.userId, 'auth_login', {
        props: { method, linked: session.isLinkedToAccount, link_code_rejected: linkCodeRejected || undefined },
      });
    }
    return { ...result, method, linkCodeRejected };
  }

  private remember(session: PlayerSession): void {
    this.cache.delete(session.userId);
    this.cache.set(session.userId, session);
    if (this.cache.size > MAX_CACHED_SESSIONS) {
      const oldest = this.cache.keys().next().value;
      if (oldest !== undefined) this.cache.delete(oldest);
    }
  }

  private requireStore(): RefreshTokenStore {
    if (!this.store) {
      throw new Error('BazinessServer: pass `refreshTokens` (a RefreshTokenStore) to use player sessions');
    }
    return this.store;
  }
}

function fromUserSession(answer: WireUserSession): SessionWithRefreshToken {
  return {
    userId: answer.userId,
    isLinkedToAccount: answer.isLinkedToAccount,
    accessToken: answer.tokens.accessToken,
    accessTokenExpiresAt: answer.tokens.accessTokenExpiresAt,
    refreshToken: answer.tokens.refreshToken,
    refreshTokenExpiresAt: answer.tokens.refreshTokenExpiresAt,
  };
}

export function toWireAttribution(attribution: Attribution | null | undefined): WireAttribution | null {
  if (!attribution) return null;
  const wire: WireAttribution = {
    utmSource: attribution.utmSource,
    utmMedium: attribution.utmMedium,
    utmCampaign: attribution.utmCampaign,
    utmContent: attribution.utmContent,
    utmTerm: attribution.utmTerm,
    linkCode: attribution.campaignCode,
    clickId: attribution.clickId,
    referrer: attribution.referrer,
    installer: attribution.installer,
    landedAt: attribution.landedAt instanceof Date ? attribution.landedAt.toISOString() : attribution.landedAt,
  };
  const entries = Object.entries(wire).filter(([, value]) => value !== undefined && value !== '');
  return entries.length ? (Object.fromEntries(entries) as WireAttribution) : null;
}

function isCode(error: unknown, code: string): boolean {
  return error instanceof BazinessError && error.code === code;
}

function sessionOver(error: unknown): boolean {
  return error instanceof BazinessError && error.code !== undefined && SESSION_OVER.has(error.code);
}
