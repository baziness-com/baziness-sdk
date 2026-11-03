import type { ServerAnalytics } from './analytics.js';
import { BazinessError, ErrorCodes } from './errors.js';
import type { Logger, Transport } from './http.js';
import type {
  Attribution,
  Campaign,
  DeviceFingerprint,
  Platform,
  PlayerSession,
  SignInMethod,
  SignInResult,
  Store,
} from './types.js';
import type {
  WireAccountData,
  WireAttribution,
  WireCampaign,
  WireLinkCode,
  WirePhoneDetail,
  WireUserAuth,
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

/** Hand a cached token out only while it has at least this long left. */
const MIN_TOKEN_LIFE_MS = 60_000;
const MAX_CACHED_SESSIONS = 10_000;
/** When a token's expiry can't be read: player tokens live for years. */
const LONG_LIVED_FALLBACK_MS = 365 * 86_400_000;

/**
 * Steps 2 and 3 of the flow: Baziness users for your players, their tokens, link codes for
 * Baziness pages, and verifying tokens that come back from a page.
 *
 * Your server stores no token: its client secret is enough to get any of its players' tokens
 * (`client/get-user-token`), and the SDK keeps them in memory.
 */
export class Players {
  private readonly cache = new Map<number, PlayerSession>();
  private readonly inFlight = new Map<number, Promise<SignInResult>>();

  constructor(
    private readonly transport: Transport,
    private readonly analytics: ServerAnalytics,
    private readonly logger: Logger,
  ) {}

  // ── High level: what a game server calls ────────────────────────────────────

  /**
   * The one call for "a player's device came online". Creates the Baziness user the first time (or
   * when the player arrived with a link code), otherwise gets the player's token. Reports
   * `auth_login` when a user was created or joined through a link code.
   *
   * Compare the returned `userId` with the one you saved: when it belongs to **another** of your
   * players, it is the same person on another device — switch this device to that player.
   */
  async signIn(input: SignInInput): Promise<SignInResult> {
    let linkCodeRejected = false;
    if (input.linkCode || !input.userId) {
      try {
        const session = await this.create(input);
        return this.keep(session, input.linkCode ? 'link_code' : 'created', false);
      } catch (error) {
        if (!(input.linkCode && isCode(error, ErrorCodes.invalidLinkCode))) throw error;
        // Expired, already used or meant for another game: carry on as if no code was sent.
        linkCodeRejected = true;
        this.logger.info('[baziness] link code rejected; continuing without it');
      }
      if (!input.userId) {
        const session = await this.create({ ...input, linkCode: null });
        return this.keep(session, 'created', true);
      }
    }
    const result = await this.session(input.userId);
    return { ...result, linkCodeRejected };
  }

  /**
   * The token of a known player: the cached one, otherwise the platform's (one request at a time
   * per player). Throws {@link BazinessError} `account_suspended` (403) for a blocked account.
   */
  async session(userId: number): Promise<SignInResult> {
    const cached = this.cache.get(userId);
    if (cached && Date.parse(cached.accessTokenExpiresAt) - Date.now() > MIN_TOKEN_LIFE_MS) {
      return { ...cached, method: 'refresh', linkCodeRejected: false };
    }
    let pending = this.inFlight.get(userId);
    if (!pending) {
      pending = this.token(userId)
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

  /** The page sent `logout`: forget the player's cached token. */
  async logout(userId: number): Promise<void> {
    this.cache.delete(userId);
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

  /**
   * Your player's install campaign. Pass the device as your server saw it (`ip` and `userAgent` of
   * the player's request, `deviceModel` and `osVersion` from the device SDK): while the install is
   * still pending (24 h after its first open, when it came with no campaign) Baziness first matches
   * it by that fingerprint to the campaign link click it most likely followed
   * (`matchType: 'probabilistic'`). Ask when the player opens the game; the answer is final once
   * `status` is no longer `pending`.
   */
  async campaign(userId: number, device?: DeviceFingerprint): Promise<Campaign> {
    const answer = await this.transport.request<WireCampaign>({
      operation: 'campaign',
      method: 'POST',
      path: `/v2/client/attribution/${userId}`,
      body: device ? fingerprintBody(device) : {},
      auth: 'client',
      // Asking again answers the same: a click wins one install, and the first answer is final.
      idempotent: true,
    });
    return fromWireCampaign(answer);
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
   * `client/create-user`: a new Baziness user for this install, or, with a link code, the user of
   * the person it stands for in your game. Answers the player's token.
   */
  async create(input: CreatePlayerInput): Promise<PlayerSession> {
    const answer = await this.transport.request<WireUserAuth>({
      operation: 'createUser',
      method: 'POST',
      path: '/client/create-user',
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
    return fromUserAuth(answer);
  }

  /** `client/get-user-token/{id}`: the token of one of your players. */
  async token(userId: number): Promise<PlayerSession> {
    const answer = await this.transport.request<WireUserAuth>({
      operation: 'userToken',
      method: 'GET',
      path: `/client/get-user-token/${userId}`,
      auth: 'client',
      idempotent: true,
    });
    return fromUserAuth(answer);
  }

  // ── Internals ─────────────────────────────────────────────────────────────────

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

function fromUserAuth(answer: WireUserAuth): PlayerSession {
  return {
    userId: answer.userId,
    isLinkedToAccount: answer.isLinkedToAccount,
    accessToken: answer.token,
    accessTokenExpiresAt: tokenExpiry(answer.token),
  };
}

/** The token's own `exp` (ISO). Reads it without checking the signature: the platform checks that. */
function tokenExpiry(token: string): string {
  try {
    const payload = JSON.parse(Buffer.from(token.split('.')[1] ?? '', 'base64url').toString('utf8')) as { exp?: number };
    if (typeof payload.exp === 'number') return new Date(payload.exp * 1000).toISOString();
  } catch {
    // Not a JWT we can read: treat it as long-lived, like every player token.
  }
  return new Date(Date.now() + LONG_LIVED_FALLBACK_MS).toISOString();
}

function fingerprintBody(device: DeviceFingerprint): Record<string, string> {
  const entries = Object.entries({
    ip: device.ip?.trim(),
    userAgent: device.userAgent,
    deviceModel: device.deviceModel?.trim(),
    osVersion: device.osVersion?.trim(),
  }).filter((entry): entry is [string, string] => typeof entry[1] === 'string' && entry[1] !== '');
  return Object.fromEntries(entries);
}

function fromWireCampaign(answer: WireCampaign): Campaign {
  const date = (value: string | null | undefined) => (value ? new Date(value) : null);
  return {
    found: answer.found === true,
    status: (answer.status ?? '') as Campaign['status'],
    matchType: (answer.matchType ?? '') as Campaign['matchType'],
    channel: answer.channel ?? '',
    utmSource: answer.utmSource ?? '',
    utmMedium: answer.utmMedium ?? '',
    utmCampaign: answer.utmCampaign ?? '',
    utmContent: answer.utmContent ?? '',
    utmTerm: answer.utmTerm ?? '',
    campaignCode: answer.linkCode ?? '',
    clickId: answer.clickId ?? '',
    installStore: answer.installStore ?? '',
    firstSeen: date(answer.firstSeen),
    attributedAt: date(answer.attributedAt),
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

