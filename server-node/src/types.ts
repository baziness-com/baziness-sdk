/** `platform` of a player's device, as `create-user` takes it. */
export type Platform = 'Android' | 'Ios' | 'Web' | 'Editor' | 'Windows' | 'Mac' | 'Linux';

/** Where the build was installed from. Web games use `Direct`. */
export type Store = 'Direct' | 'GooglePlay' | 'AppStore' | 'CafeBazaar' | 'Myket';

/** Payment gateway of a purchase the game server reports. Baziness Pay reports its own payments. */
export type PaymentGateway = 'cafebazaar' | 'myket' | 'googleplay' | 'appstore' | 'direct';

/**
 * First-touch attribution, collected by the device SDK on first open (landing UTMs, campaign link,
 * store referrer) and forwarded by the game server when it creates the player.
 */
export interface Attribution {
  utmSource?: string;
  utmMedium?: string;
  utmCampaign?: string;
  utmContent?: string;
  utmTerm?: string;
  /** Campaign link code (`bz_lc` on a Baziness campaign link). Not the sign-in link code. */
  campaignCode?: string;
  /** Click id (`bz_click`) of that campaign link. */
  clickId?: string;
  /** Raw install referrer (Google Play, Cafe Bazaar, Myket). */
  referrer?: string;
  /** Android installer package, e.g. `com.farsitel.bazaar`. */
  installer?: string;
  landedAt?: string | Date;
}

/**
 * What the device SDK reports about the player's device (`Baziness.device` on the web,
 * `BazinessSdk.Device` in Unity). The game server forwards it with the session start, so it reaches
 * Baziness through the trusted channel.
 */
export interface DeviceInfo {
  deviceId?: string;
  platform?: string;
  store?: string;
  model?: string;
  manufacturer?: string;
  /** `phone`, `tablet`, `desktop`, `console` or `unknown`. */
  deviceType?: string;
  os?: string;
  osVersion?: string;
  appVersion?: string;
  /** `unity` or `web`. */
  sdk?: string;
  sdkVersion?: string;
  locale?: string;
  timezone?: string;
  screenWidth?: number;
  screenHeight?: number;
  dpi?: number;
  memoryMb?: number;
  browser?: string;
  installer?: string;
  network?: string;
}

/** A player's Baziness session as your game server hands it to the player's device. */
export interface PlayerSession {
  /** The Baziness user id of this player (one per game install, joined into a person by Baziness). */
  userId: number;
  /** True once the player signed in with a phone number (a Baziness account), false while anonymous. */
  isLinkedToAccount: boolean;
  /** 15-minute access token: the device uses it for its own Baziness calls. */
  accessToken: string;
  /** ISO time the access token expires. */
  accessTokenExpiresAt: string;
}

/** How {@link Players.signIn} found the session. */
export type SignInMethod =
  /** A new Baziness user was created for this device. */
  | 'created'
  /** The player arrived with a link code (from the Baziness app or another game): same person. */
  | 'link_code'
  /** A known player's session was renewed with its refresh token. */
  | 'refresh'
  /** A known player had no live session; a new one was started. */
  | 'new_session';

export interface SignInResult extends PlayerSession {
  method: SignInMethod;
  /** A link code was sent but had expired or was already used; the player continued without it. */
  linkCodeRejected: boolean;
}

/**
 * Where the game keeps each player's refresh token. The token is a password: store it on your
 * server only (a `baziness_sessions` table keyed by the Baziness user id, or Redis), never log it,
 * never send it to a device. `set(userId, null)` removes it.
 */
export interface RefreshTokenStore {
  get(userId: number): Promise<string | null>;
  set(userId: number, refreshToken: string | null): Promise<void>;
}

/** In-memory {@link RefreshTokenStore} for tests and local development. Lost on restart. */
export class MemoryRefreshTokenStore implements RefreshTokenStore {
  private readonly tokens = new Map<number, string>();

  async get(userId: number): Promise<string | null> {
    return this.tokens.get(userId) ?? null;
  }

  async set(userId: number, refreshToken: string | null): Promise<void> {
    if (refreshToken) this.tokens.set(userId, refreshToken);
    else this.tokens.delete(userId);
  }
}
