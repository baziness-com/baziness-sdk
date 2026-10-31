/**
 * Request and response bodies exactly as the platform API sends them (camelCase JSON). The public
 * SDK types in `types.ts` are friendlier; these stay internal.
 */

export interface ClientAuthResponse {
  clientId: number;
  token: string;
}

export interface WireTokenPair {
  accessToken: string;
  accessTokenExpiresAt: string;
  refreshToken: string;
  refreshTokenExpiresAt: string;
}

/** `v2/client/create-user` and `v2/client/get-user-token/{id}`. */
export interface WireUserSession {
  userId: number;
  token: string;
  isLinkedToAccount: boolean;
  tokens: WireTokenPair;
}

/**
 * `v2/client/access-token/{id}` and `v2/client/create-user` with `accessTokenOnly`: an access
 * token alone, no refresh token.
 */
export interface WireAccessTokenSession {
  userId: number;
  token: string;
  isLinkedToAccount: boolean;
  accessTokenExpiresAt: string;
}

/** `auth/refresh`. */
export interface WireRefreshResponse extends WireTokenPair {
  userId: number;
  isLinkedToAccount: boolean;
}

export interface WireLinkCode {
  code: string;
  expiresAt: string;
}

export interface WireValidateToken {
  userId: number;
  isValid: boolean;
}

export interface WirePhoneDetail {
  isRegistered: boolean;
  userId: number | null;
}

export interface WireOffer {
  bundle_id: number | null;
  code?: string | null;
  message?: string | null;
}

export interface WireResource {
  resourceId: number;
  amount: number;
}

export interface WireAccountData {
  accountId: number;
  phoneNumber: string;
  fullName: string;
  nationalCode: string;
  isActive: boolean;
}

/** First-touch attribution as `create-user` and `analytics/attribution` take it. */
export interface WireAttribution {
  utmSource?: string;
  utmMedium?: string;
  utmCampaign?: string;
  utmContent?: string;
  utmTerm?: string;
  /** Campaign link code (`bz_lc`) — not the sign-in link code. */
  linkCode?: string;
  clickId?: string;
  referrer?: string;
  installer?: string;
  landedAt?: string;
}

export interface WireServerEvent {
  eventId: string;
  eventKey: string;
  userId: number;
  clientTime: string;
  sessionId?: string;
  appVersion?: string;
  value?: number;
  props?: Record<string, string>;
}

export interface WireEventBatchResponse {
  accepted: number;
  rejected: number;
  errors: string[];
}
