import { createHash } from 'node:crypto';
import { BazinessError, ErrorCodes } from './errors.js';
import type { Transport } from './http.js';
import type { WireResource } from './wire.js';

export interface AddCoinsInput {
  userId: number;
  /** Positive number of Gita coins. */
  amount: number;
  /**
   * What this payout **is**, e.g. `match:17`, `reward_claim:42`, `tutorial_gift`. The same payout
   * always gives the same transaction id, so a retry, a double tap or a crash never pays twice.
   * Pass either this or `transactionId`.
   */
  grantKey?: string;
  /** Your own unique id for this payout, when you already have one. */
  transactionId?: string;
  /** Any JSON stored with the transaction (source, match id, …), for reports. */
  metadata?: unknown;
}

export interface AddCoinsResult {
  /** Coins credited by this call (the platform answers with the amount, not the balance); null when already credited. */
  credited: number | null;
  /**
   * An attempt of this call reached the platform without an answer (timeout, 500) and the platform
   * refused the retry as already applied: treat it as paid.
   */
  alreadyCredited: boolean;
  transactionId: string;
}

/** Gita coins (step 4): give coins to your players and read their balance. */
export class Coins {
  constructor(private readonly transport: Transport) {}

  /**
   * Credit coins. The transaction id is derived from `grantKey`, so the same payout never pays twice.
   *
   * The platform answers every refusal alike (`add resource failed`: wallet short of coins, id already
   * paid, …). When this call had sent the payout before without an answer, a refusal means the first
   * attempt was applied: `alreadyCredited`. Otherwise it throws `add_coin_refused`
   * (`ErrorCodes.addCoinRefused`): nothing was paid by this call — do not show the coins.
   */
  async add(input: AddCoinsInput): Promise<AddCoinsResult> {
    if (!Number.isSafeInteger(input.amount) || input.amount <= 0) {
      throw new RangeError('coins.add: amount must be a positive integer');
    }
    const transactionId = input.transactionId ?? (input.grantKey ? transactionIdFor(input.userId, input.amount, input.grantKey) : undefined);
    if (!transactionId) {
      throw new TypeError('coins.add: pass grantKey (or transactionId) so the payout cannot be paid twice');
    }
    const outcome = { resentAfterUnknownOutcome: false };
    try {
      const answer = await this.transport.request<WireResource>({
        operation: 'addCoin',
        method: 'POST',
        path: '/client/add-coin',
        // No metaData field at all when there is none: older hubs answer 500 to `"metaData": null`.
        body: { userId: input.userId, amount: input.amount, transactionId, metaData: input.metadata ?? undefined },
        auth: 'client',
        idempotent: true,
        outcome,
      });
      return { credited: answer.amount, alreadyCredited: false, transactionId };
    } catch (error) {
      if (!(error instanceof BazinessError && error.status === 400 && /add resource failed/i.test(error.code ?? ''))) {
        throw error;
      }
      if (outcome.resentAfterUnknownOutcome) return { credited: null, alreadyCredited: true, transactionId };
      throw new BazinessError(
        `coins.add: the platform refused the payout (add resource failed): your coin wallet may be short of coins, or transaction ${transactionId} was paid by an earlier call`,
        'addCoin',
        400,
        ErrorCodes.addCoinRefused,
      );
    }
  }

  /** A player's Gita coin balance. */
  async balance(userId: number): Promise<number> {
    const answer = await this.transport.request<WireResource>({
      operation: 'getCoin',
      method: 'GET',
      path: `/client/get-coin/${userId}`,
      auth: 'client',
      idempotent: true,
    });
    return answer.amount;
  }
}

/** `<userId>_<amount>_<first 24 hex chars of sha1(grantKey)>`, the platform's convention. */
export function transactionIdFor(userId: number, amount: number, grantKey: string): string {
  const digest = createHash('sha1').update(grantKey).digest('hex').slice(0, 24);
  return `${userId}_${amount}_${digest}`;
}
