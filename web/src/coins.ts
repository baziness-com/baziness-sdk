import type { TokenSource } from './analytics.js';

/** The player's Gita coin balance, read with their own token. Giving coins is a server call. */
export class CoinBalance {
  constructor(
    private readonly apiBase: string,
    private readonly token: TokenSource,
    private readonly fetchImpl: typeof fetch,
  ) {}

  /**
   * Read it when the session starts, when a Baziness page closes (the player may have spent coins),
   * when the game returns to the foreground and after your server gave coins.
   */
  async balance(): Promise<number> {
    for (let attempt = 0; attempt < 2; attempt++) {
      const response = await this.fetchImpl(`${this.apiBase}/user/get-coin`, {
        headers: { Authorization: `Bearer ${await this.token(attempt > 0)}` },
      });
      if (response.status === 401 && attempt === 0) continue;
      if (!response.ok) throw new Error(`Baziness: get-coin HTTP ${response.status}`);
      return ((await response.json()) as { amount: number }).amount;
    }
    throw new Error('Baziness: get-coin unauthorized');
  }
}
