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
  WireAccessTokenSession,
  WireAccountData,
  WireAttribution,
  WireLinkCode,
  WirePhoneDetail,
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

/** Hand a cached access token out only while it has at least this long left. */
const MIN_TOKEN_LIFE_MS = 60_000;
const MAX_CACHED_SESSIONS = 10_000;

/**
 * Steps 2 and 3 of the flow: Baziness users for your players, their 15-minute access tokens, link
 * codes for Baziness pages, and verifying tokens that come back from a page.
 *
 * Your server keeps no token: its client secret is enough to get a new access token for any of its
 * players (`v2/client/access-token`), so there is no refresh token to store, rotate or leak.
 */
export class Players {
  private readonly cache = new Map<number, PlayerSession>();
  private readonly inFlight = new Map<number, Promise<SignInResult>>();

  constructor(
    private readonly transport: Transport,
    /** Only for integrations from 1.0, which kept refresh tokens: logout ends that leftover session. */
    private readonly store: RefreshTokenStore | undefined,
    private readonly analytics: ServerAnalytics,
    private readonly logger: Logger,
  ) {}

  // ── High level: what a game server calls ────────────────────────────────────

  /**
   * The one call for "a player's device came online". Creates the Baziness user the first time (or
   * when the player arrived with a link code), otherwise gets a fresh access token for them. Reports
   * `auth_login` when a user was created or joined through a link code.
   *
   * Compare the returned `userId` with the one you saved: when it belongs to **another** of your
   * players, it is the same person on another device — switch this device to that player.
   */
  async signIn(input: SignInInput): Promise<SignInResult> {
    let linkCodeRejected = false;
    if (input.linkCode || !input.userId) {
      try {
        const session = await this.createPlayer(input);
        return this.keep(session, input.linkCode ? 'link_code' : 'created', false);
      } catch (error) {
        if (!(input.linkCode && isCode(error, ErrorCodes.invalidLinkCode))) throw error;
        // Expired, already used or meant for another game: carry on as if no code was sent.
        linkCodeRejected = true;
        this.logger.info('[baziness] link code rejected; continuing without it');
      }
      if (!input.userId) {
        const session = await this.createPlayer({ ...input, linkCode: null });
        return this.keep(session, 'created', true);
      }
    }
    const result = await this.session(input.userId);
    return { ...result, linkCodeRejected };
  }

  /**
   * A valid access token for a known player: the cached one while it has a minute left, otherwise a
   * new one (one request at a time per player). Throws {@link BazinessError} `account_suspended`
   * (403) for a blocked account.
   */
  async session(userId: number): Promise<SignInResult> {
    const cached = this.cache.get(userId);
    if (cached && Date.parse(cached.accessTokenExpiresAt) - Date.now() > MIN_TOKEN_LIFE_MS) {
      return { ...cached, method: 'refresh', linkCodeRejected: false };
    }
    let pending = this.inFlight.get(userId);
    if (!pending) {
      pending = this.accessToken(userId)
        .then((session) => this.keep(session, 'refresh', false))
        .finally(() => this.inFlight.delete(userId));
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

  /**
   * The page sent `logout`: forget the player's cached token. A refresh token that an integration
   * from 1.0 still keeps in `refreshTokens` is revoked and removed.
   */
  async logout(userId: number): Promise<void> {
    this.cache.delete(userId);
    if (!this.store) return;
    const refreshToken = await this.store.get(userId);
    if (refreshToken) {
      await this.revoke(refreshToken).catch((error: unknown) =>
        this.logger.warn(`[baziness] logout: ${(error as Error).message}`),
      );
    }
    await this.store.set(userId, null);
  }

  /**
   * The Baziness user id of your player who signed in with this phone number, or null when none of
   * your players did (for example to reward a phone number a campaign or partner sends you).
   */
  async findByPhone(phoneNumber: string): Promise<number | null> {
    if (!phoneNumber?.trim()) throw new TypeError('players.findByPhone: phoneNumber is required');
    const answer = await this.transport.request<WirePhoneDetail>({
      operation: 'checkPhoneNumber',
      method: 'GET',
      path: `/client/check-phone-number/${encodeURIComponent(phoneNumber.trim())}`,
      auth: 'client',
      idempotent: true,
    });
    return answer.isRegistered && answer.userId ? answer.userId : null;
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

  // ── Low level: one platform call each ─────────────────────────────────────────

  /**
   * `v2/client/access-token/{id}`: a 15-minute access token for one of your players, no refresh
   * token. Ask again when it runs out; {@link session} caches it for you.
   */
  async accessToken(userId: number): Promise<PlayerSession> {
    const answer = await this.transport.request<WireAccessTokenSession>({
      operation: 'accessToken',
      method: 'POST',
      path: `/v2/client/access-token/${userId}`,
      auth: 'client',
      // Issues a token and nothing else: safe to repeat.
      idempotent: true,
    });
    return fromAccessTokenSession(answer);
  }

  /**
   * `v2/client/create-user` with a token pair (a refresh token you keep yourself). Kept for
   * integrations from 1.0; {@link signIn} keeps no refresh token.
   */
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

  /** `v2/client/get-user-token/{id}`: a session with a refresh token (integrations from 1.0). */
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

  /** `v2/client/create-user` with `accessTokenOnly`: the new user and an access token, nothing to keep. */
  private async createPlayer(input: CreatePlayerInput): Promise<PlayerSession> {
    const answer = await this.transport.request<WireAccessTokenSession>({
      operation: 'createUser',
      method: 'POST',
      path: '/v2/client/create-user',
      body: {
        deviceId: input.deviceId,
        platform: input.platform,
        store: input.store,
        linkCode: input.linkCode || null,
        attribution: toWireAttribution(input.attribution),
        accessTokenOnly: true,
      },
      auth: 'client',
      // A retried create could consume the link code twice or create a second user.
      idempotent: false,
    });
    return fromAccessTokenSession(answer);
  }

  private keep(session: PlayerSession, method: SignInMethod, linkCodeRejected: boolean): SignInResult {
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
}

function fromAccessTokenSession(answer: WireAccessTokenSession): PlayerSession {
  return {
    userId: answer.userId,
    isLinkedToAccount: answer.isLinkedToAccount,
    accessToken: answer.token,
    accessTokenExpiresAt: answer.accessTokenExpiresAt,
  };
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

