import type { TokenSource } from './analytics.js';
import type { DeviceInfo } from './device.js';

/**
 * The install's campaign as Baziness knows it. An install that came with no campaign (no campaign
 * link, UTMs, store referrer or APK campaign) is `pending` for 24 hours after its first open; asking
 * during that time matches it by this device's fingerprint to the campaign link click it most likely
 * followed (`matchType: 'probabilistic'`). After that it is `organic`.
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

interface WireCampaign {
  found?: boolean;
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

/**
 * The player's install campaign, asked from this device with the player's token: Baziness sees this
 * device's IP and User-Agent itself, and the model and OS version come with the request.
 */
export class InstallCampaign {
  constructor(
    private readonly apiBase: string,
    private readonly token: TokenSource,
    private readonly device: DeviceInfo,
    private readonly fetchImpl: typeof fetch,
  ) {}

  /** Ask when the game starts; the answer is final once `status` is no longer `pending`. */
  async get(): Promise<Campaign> {
    const body = JSON.stringify(
      Object.fromEntries(Object.entries({ deviceModel: this.device.model, osVersion: this.device.osVersion }).filter(([, v]) => v)),
    );
    for (let attempt = 0; attempt < 2; attempt++) {
      const response = await this.fetchImpl(`${this.apiBase}/analytics/attribution/resolve`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${await this.token(attempt > 0)}` },
        body,
      });
      if (response.status === 401 && attempt === 0) continue;
      if (!response.ok) throw new Error(`Baziness: campaign HTTP ${response.status}`);
      return fromWire((await response.json()) as WireCampaign);
    }
    throw new Error('Baziness: campaign unauthorized');
  }
}

function fromWire(answer: WireCampaign): Campaign {
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
