import type { TokenSource } from './analytics.js';

/** A GET with the player's token that asks your server for a new token once when it answers 401. */
async function playerGet(apiBase: string, path: string, token: TokenSource, fetchImpl: typeof fetch, operation: string): Promise<unknown> {
  for (let attempt = 0; attempt < 2; attempt++) {
    const response = await fetchImpl(`${apiBase}${path}`, {
      headers: { Authorization: `Bearer ${await token(attempt > 0)}` },
    });
    if (response.status === 401 && attempt === 0) continue;
    if (!response.ok) throw new Error(`Baziness: ${operation} HTTP ${response.status}`);
    return response.json();
  }
  throw new Error(`Baziness: ${operation} unauthorized`);
}

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
    const answer = (await playerGet(this.apiBase, '/user/get-coin', this.token, this.fetchImpl, 'get-coin')) as { amount: number };
    return answer.amount;
  }
}

/** Referral rewards the player can collect on the referral page: a badge for your referral button. */
export class ReferralRewards {
  constructor(
    private readonly apiBase: string,
    private readonly token: TokenSource,
    private readonly fetchImpl: typeof fetch,
  ) {}

  /** Invited friends whose reward is waiting. Read it on start and when the referral page closes. */
  async collectable(): Promise<number> {
    return Number(await playerGet(this.apiBase, '/user/referral-collectable-accounts-count', this.token, this.fetchImpl, 'referral-count'));
  }
}
