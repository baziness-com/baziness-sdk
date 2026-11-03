/**
 * Request and response bodies exactly as the platform API sends them (camelCase JSON). The public
 * SDK types in `types.ts` are friendlier; these stay internal.
 */

export interface ClientAuthResponse {
  clientId: number;
  token: string;
}

/** `client/create-user` and `client/get-user-token/{id}`: the player and their long-lived token. */
export interface WireUserAuth {
  userId: number;
  token: string;
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
export interface WireCampaign {
  found: boolean;
  status?: string;
  matchType?: string;
  channel?: string;
  utmSource?: string;
  utmMedium?: string;
  utmCampaign?: string;
  utmContent?: string;
  utmTerm?: string;
  linkCode?: string;
  clickId?: string;
  installStore?: string;
  firstSeen?: string | null;
  attributedAt?: string | null;
}

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
