import type { DeviceAnalytics } from './analytics.js';
import type { Attribution } from './launch.js';
import type { KeyValueStore } from './storage.js';

/** The event Baziness analytics joins a tracker's own install records on (props `tracker`, `device_id`). */
export const TRACKER_DEVICE_EVENT = 'baziness:tracker:device';
/** One per tracker answer, whether or not it became the install's campaign (props `tracker`, `source`, `campaign`). */
export const TRACKER_ANSWER_EVENT = 'baziness:attribution:tracker';

const SOURCE_KEYS = ['utm_source', 'source', 'media_source', 'network', 'publisher', 'acquisitionSource'];
const MEDIUM_KEYS = ['utm_medium', 'medium'];
const CAMPAIGN_KEYS = ['utm_campaign', 'campaign', 'campaign_name', 'acquisitionCampaign'];
const CONTENT_KEYS = ['utm_content', 'adset', 'ad_set', 'adgroup', 'ad_group', 'acquisitionAdSet'];
const TERM_KEYS = ['utm_term', 'ad', 'creative', 'acquisitionAd'];

/** A campaign is known: UTMs or a Baziness campaign link (a referrer alone is not one). */
export function hasCampaign(attribution: Attribution | null | undefined): boolean {
  return Boolean(attribution?.utmSource || attribution?.campaignCode || attribution?.clickId);
}

/**
 * What an attribution SDK (Metrix, AppMetrica, Adjust, …) reported for this install, as first-touch
 * attribution. Takes UTMs, a Baziness link's `bz_lc` / `bz_click` (AppMetrica's deferred deep link
 * parameters carry them), or the tracker's own field names. An empty or organic answer is no campaign: null.
 */
export function trackerAttribution(
  values: Record<string, string | null | undefined> | null | undefined,
  now: Date = new Date(),
): Attribution | null {
  if (!values) return null;
  const known = new Map<string, string>();
  for (const [key, value] of Object.entries(values)) {
    const name = key.trim().toLowerCase();
    const text = typeof value === 'string' ? value.trim() : '';
    if (name && text && !known.has(name)) known.set(name, text);
  }
  const pick = (keys: string[]) => keys.map((key) => known.get(key.toLowerCase())).find(Boolean);
  const attribution: Attribution = {
    utmSource: pick(SOURCE_KEYS),
    utmMedium: pick(MEDIUM_KEYS),
    utmCampaign: pick(CAMPAIGN_KEYS),
    utmContent: pick(CONTENT_KEYS),
    utmTerm: pick(TERM_KEYS),
    campaignCode: known.get('bz_lc'),
    clickId: known.get('bz_click'),
  };
  if (!hasCampaign(attribution) || isOrganic(attribution)) return null;
  for (const key of Object.keys(attribution) as Array<keyof Attribution>) {
    if (attribution[key] === undefined) delete attribution[key];
  }
  attribution.landedAt = now.toISOString();
  return attribution;
}

// Trackers say "organic" for an install they found no campaign for (Google Play's own referrer says
// utm_medium=organic); a Baziness link in the answer is a campaign all the same.
function isOrganic(attribution: Attribution): boolean {
  if (attribution.campaignCode || attribution.clickId) return false;
  return [attribution.utmSource, attribution.utmMedium].some((value) => value?.toLowerCase() === 'organic');
}

/**
 * The ids attribution trackers gave this device (AppMetrica device id), sent once per player as
 * `baziness:tracker:device` so Baziness can match the tracker's own install records to this install.
 * Kept for the page's life: a player who signs in as someone else gets them sent for them too.
 */
export class TrackerDevices {
  private readonly ids = new Map<string, string>();

  constructor(
    private readonly analytics: DeviceAnalytics,
    private readonly store: KeyValueStore,
  ) {}

  /** Remember a tracker's id of this device; true when it is new or changed. */
  report(tracker: string, deviceId: string): boolean {
    const name = tracker?.trim().toLowerCase();
    const id = deviceId?.trim();
    if (!name || !id || this.ids.get(name) === id) return false;
    this.ids.set(name, id);
    return true;
  }

  /** Send what this player has not been sent yet. Needs the player: the event belongs to them. */
  send(userId: number | undefined): void {
    if (!userId || userId <= 0) return;
    for (const [tracker, id] of this.ids) {
      const key = `baziness:tracker:device:${tracker}`;
      const sent = `${userId}:${id}`;
      if (this.store.get(key) === sent) continue;
      if (this.analytics.record(TRACKER_DEVICE_EVENT, { props: { tracker, device_id: id } })) this.store.set(key, sent);
    }
  }
}
