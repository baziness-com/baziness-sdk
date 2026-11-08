import { BazinessError } from './errors.js';
import type { Transport } from './http.js';

/** The sponsor ad assigned to this game. Fetching it does not count an impression. */
export interface Ad {
  id: number;
  title: string;
  imageUrl: string;
  link: string;
}

/** Sponsor ads and their views/clicks. Uses the game's client token; server only. */
export class Ads {
  constructor(private readonly transport: Transport) {}

  /** The game's current ad, or null when none is assigned (204 or JSON null). */
  async get(): Promise<Ad | null> {
    const value = await this.transport.request<Ad | null>({
      operation: 'getAd', method: 'GET', path: '/content/get-ad', auth: 'client', idempotent: true,
    });
    if (value == null) return null;
    if (!Number.isSafeInteger(value.id) || value.id <= 0 || typeof value.title !== 'string'
      || typeof value.imageUrl !== 'string' || typeof value.link !== 'string') {
      throw new BazinessError('getAd: the platform sent an invalid ad', 'getAd', 200);
    }
    return { id: value.id, title: value.title, imageUrl: value.imageUrl, link: value.link };
  }

  /** Call once when the player sees the ad; userId is the Baziness user id, not the game's id. */
  async seen(adId: number, userId: number): Promise<void> {
    await this.track(adId, userId, 'seen');
  }

  /** Call once when the player clicks the ad they were shown. */
  async click(adId: number, userId: number): Promise<void> {
    await this.track(adId, userId, 'click');
  }

  private async track(adId: number, userId: number, eventType: 'seen' | 'click'): Promise<void> {
    if (!Number.isSafeInteger(adId) || adId <= 0 || !Number.isSafeInteger(userId) || userId <= 0) {
      throw new TypeError('adId and Baziness userId must be positive safe integers');
    }
    // Counts events: no replay after an uncertain outcome (timeout, 500, 504).
    await this.transport.request<void>({
      operation: 'trackAdEvent', method: 'POST', path: '/content/ad-event',
      body: { adId, userId, eventType }, auth: 'client', idempotent: false, expectJson: false,
    });
  }
}
