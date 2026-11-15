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
  /**
   * `document.referrer` of the first landing, when it was another site, or the store install referrer
   * a wrapper app passed (`setInstallReferrer`).
   */
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
  /**
   * Ids attribution trackers gave this device, by tracker, from a wrapper app that opened the game with
   * them (`appmetrica_device_id`): what `reportTrackerDevice` takes, for wrappers that cannot call it.
   */
  trackerDevices?: Record<string, string>;
}

const ATTRIBUTION_KEY = 'baziness:attribution';
/** Launch parameters a wrapper app adds for a tracker's id of this device, and the tracker each names. */
const TRACKER_DEVICE_PARAMS: Array<[string, string]> = [['appmetrica_device_id', 'appmetrica']];
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
const CONSUMED = ['linkCode', 'linkedToken', ...UTM.map(([param]) => param), ...TRACKER_DEVICE_PARAMS.map(([param]) => param)];

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
  const trackerDevices: Record<string, string> = {};
  for (const [param, tracker] of TRACKER_DEVICE_PARAMS) {
    const value = params.get(param)?.trim();
    if (value) trackerDevices[tracker] = value.slice(0, 128);
  }

  let attribution = readJson<Attribution>(store, ATTRIBUTION_KEY);
  if (!attribution && (Object.keys(landing).length > 0 || externalReferrer)) {
    attribution = { ...landing, landedAt: now.toISOString() };
    if (externalReferrer) attribution.referrer = externalReferrer.slice(0, 512);
    saveAttribution(store, attribution);
  }

  let consumed = false;
  for (const key of CONSUMED) {
    if (params.has(key)) {
      params.delete(key);
      consumed = true;
    }
  }
  const launch: LaunchParams = { linkCode, attribution };
  if (Object.keys(trackerDevices).length > 0) launch.trackerDevices = trackerDevices;
  return { launch, cleanHref: consumed ? url.toString() : null };
}

/** Keep the install's first-touch attribution (it changes only while it has no campaign). */
export function saveAttribution(store: KeyValueStore, attribution: Attribution): void {
  store.set(ATTRIBUTION_KEY, JSON.stringify(attribution));
}

function sameSite(referrer: string, url: URL): boolean {
  try {
    return new URL(referrer).host === url.host;
  } catch {
    return false;
  }
}
