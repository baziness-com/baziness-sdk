/** `platform` of a player's device, as `create-user` takes it. */
export type Platform = 'Android' | 'Ios' | 'Web' | 'Editor' | 'Windows' | 'Mac' | 'Linux';

/** Where the build was installed from. Web games use `Direct`. */
export type Store = 'Direct' | 'GooglePlay' | 'AppStore' | 'CafeBazaar' | 'Myket';

/** Payment gateway of a purchase the game server reports: every payment, Baziness Pay included. */
export type PaymentGateway = 'baziness_pay' | 'cafebazaar' | 'myket' | 'googleplay' | 'appstore' | 'direct';

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

/**
 * The player's device as your server saw it, for fingerprint attribution: the IP and User-Agent of
 * the player's request (behind a proxy: the forwarded client IP), plus the model and OS version the
 * device SDK reports (`DeviceInfo.model`, `DeviceInfo.osVersion`). Without an IP, nothing is matched.
 */
export interface DeviceFingerprint {
  ip?: string;
  userAgent?: string;
  deviceModel?: string;
  osVersion?: string;
}

/**
 * The install's campaign as Baziness knows it. An install that came with no campaign (no campaign
 * link, UTMs, store referrer or APK campaign) is `pending` for 24 hours after its first open; asking
 * with the device's fingerprint during that time matches it to the campaign link click it most
 * likely followed (`matchType: 'probabilistic'`). After that it is `organic`.
 */
export interface Campaign {
  /** False: Baziness has nothing for this player yet (just created; ask again shortly). */
  found: boolean;
  status: 'pending' | 'attributed' | 'organic' | 'legacy' | '';
  /** `deterministic`: link, store referrer or APK campaign. `probabilistic`: matched by fingerprint. */
  matchType: 'deterministic' | 'probabilistic' | 'none' | '';
  channel: string;
  utmSource: string;
  utmMedium: string;
  utmCampaign: string;
  utmContent: string;
  utmTerm: string;
  /** Campaign link code (`bz_lc`). */
  campaignCode: string;
  clickId: string;
  /** `googleplay`, `cafebazaar`, `myket`, `direct` or empty. */
  installStore: string;
  firstSeen: Date | null;
  attributedAt: Date | null;
}

/** A player's Baziness session as your game server hands it to the player's device. */
export interface PlayerSession {
  /** The Baziness user id of this player (one per game install, joined into a person by Baziness). */
  userId: number;
  /** True once the player signed in with a phone number (a Baziness account), false while anonymous. */
  isLinkedToAccount: boolean;
  /** The player's token (long-lived): the device uses it for its own Baziness calls. */
  accessToken: string;
  /** ISO time the token expires (years away; the device asks your server again after it). */
  accessTokenExpiresAt: string;
}

/** How {@link Players.signIn} found the session. */
export type SignInMethod =
  /** A new Baziness user was created for this device. */
  | 'created'
  /** The player arrived with a link code (from the Baziness app or another game): same person. */
  | 'link_code'
  /** A known player got their token. */
  | 'refresh';

export interface SignInResult extends PlayerSession {
  method: SignInMethod;
  /** A link code was sent but had expired or was already used; the player continued without it. */
  linkCodeRejected: boolean;
}
