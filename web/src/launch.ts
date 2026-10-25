import { readJson, type KeyValueStore } from './storage.js';

/** First-touch attribution, kept from the first landing and never overwritten by a later one. */
export interface Attribution {
  utmSource?: string;
  utmMedium?: string;
  utmCampaign?: string;
  utmContent?: string;
  utmTerm?: string;
  /** Campaign link code (`bz_lc` on a Baziness campaign link). */
  campaignCode?: string;
  /** Campaign click id (`bz_click`). */
  clickId?: string;
  /** `document.referrer` of the first landing, when it was another site. */
  referrer?: string;
  landedAt?: string;
}

/** What the page address carried when the game was opened. */
export interface LaunchParams {
  /**
   * One-time sign-in code: the Baziness app or another game opened this game for a known person.
   * Send it with the first session request; it works once.
   */
  linkCode: string | null;
  attribution: Attribution | null;
}

const ATTRIBUTION_KEY = 'baziness:attribution';
const UTM: Array<[string, keyof Attribution]> = [
  ['utm_source', 'utmSource'],
  ['utm_medium', 'utmMedium'],
  ['utm_campaign', 'utmCampaign'],
  ['utm_content', 'utmContent'],
  ['utm_term', 'utmTerm'],
  ['bz_lc', 'campaignCode'],
  ['bz_click', 'clickId'],
];
/** Removed from the address after reading: a code works once, and none of these belong in history. */
const CONSUMED = ['linkCode', 'linkedToken', ...UTM.map(([param]) => param)];

/**
 * Reads the launch parameters once, keeps the first-touch attribution and returns the address
 * without them (the caller replaces the history entry with it).
 */
export function readLaunch(
  href: string,
  referrer: string,
  store: KeyValueStore,
  now: Date = new Date(),
): { launch: LaunchParams; cleanHref: string | null } {
  const url = new URL(href);
  const params = url.searchParams;
  const linkCode = params.get('linkCode')?.trim() || null;

  const landing: Attribution = {};
  for (const [param, field] of UTM) {
    const value = params.get(param)?.trim();
    if (value) landing[field] = value;
  }
  const externalReferrer = referrer && !sameSite(referrer, url) ? referrer : undefined;

  let attribution = readJson<Attribution>(store, ATTRIBUTION_KEY);
  if (!attribution && (Object.keys(landing).length > 0 || externalReferrer)) {
    attribution = { ...landing, landedAt: now.toISOString() };
    if (externalReferrer) attribution.referrer = externalReferrer.slice(0, 512);
    store.set(ATTRIBUTION_KEY, JSON.stringify(attribution));
  }

  let consumed = false;
  for (const key of CONSUMED) {
    if (params.has(key)) {
      params.delete(key);
      consumed = true;
    }
  }
  return { launch: { linkCode, attribution }, cleanHref: consumed ? url.toString() : null };
}

function sameSite(referrer: string, url: URL): boolean {
  try {
    return new URL(referrer).host === url.host;
  } catch {
    return false;
  }
}
