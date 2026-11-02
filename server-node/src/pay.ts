import { BazinessError } from './errors.js';
import type { Transport } from './http.js';

/** A payment the player completed on the Baziness Pay checkout page and your game has not consumed yet. */
export interface BazinessPayment {
  /** Your player id (Pay's `uid`). */
  playerId: number;
  sku: string;
  /** The payment's token: what your server checks with `verify` and keeps to grant it once. */
  token: string;
  transactionId?: string;
  /** What the player paid, in Toman. */
  amount?: number;
  packageTitle?: string;
  /** The bank gateway behind the checkout (`zarinpal`, `tara`, `snappPay`, …). */
  gateway?: string;
  submittedAt?: string;
}

/** Baziness Pay's answers: HTTP 200 with `success`, plus the payment or an `error` code. */
interface WirePayAnswer {
  success?: boolean;
  error?: string;
  uid?: number;
  sku?: string;
  token?: string;
  transactionId?: string;
  amount?: number;
  packageTitle?: string;
  gateway?: string;
  submittedAt?: string;
}

/** Pay's answer when there is no such payment (not paid, not yet reported by the gateway, or consumed). */
const NOT_VALID = 'payment_is_not_valid';

/**
 * Baziness Pay: the web checkout (`pay.baziness.com`) for packages registered in Pay under your app's
 * package name. Report each payment you granted like any other: `purchases.record` with gateway
 * `baziness_pay` and the payment's token as the order id.
 *
 * The flow: the device opens the checkout page (device SDK `openCheckout`), the player pays and comes
 * back to the game, taps "Complete purchase", the device finds the payment (`findPayment`) and sends its
 * token to your server. Your server checks it with {@link verify}, grants the package once per token,
 * then calls {@link consume} so the player can buy the same package again.
 *
 * ```ts
 * const pay = baziness.pay('com.example.game');
 * if (await pay.verify(playerId, sku, token)) {
 *   await grantOnce(playerId, sku, token); // your own idempotent grant, keyed by the token
 *   await pay.consume(playerId, sku);
 * }
 * ```
 */
export class Pay {
  constructor(
    private readonly transport: Transport,
    /** Your app's package name in Baziness Pay (Pay's `pname`). */
    readonly packageName: string,
  ) {
    if (!packageName?.trim()) throw new TypeError('pay: packageName is required (your app in Baziness Pay)');
  }

  /**
   * The player's paid, unconsumed payment for this package, or null when there is none: not paid yet,
   * still on the bank's page, or already consumed. A server can complete a checkout with this alone,
   * without a token from the device.
   */
  async find(playerId: number, sku: string): Promise<BazinessPayment | null> {
    const answer = await this.call('payFind', '/get_payment', { uid: playerId, sku, pname: this.packageName });
    if (!answer.success) return notValidOrThrow(answer, 'payFind', null);
    if (!answer.token) throw new BazinessError('pay.find: Baziness Pay sent a payment without a token', 'payFind', 200);
    return {
      playerId: Number(answer.uid ?? playerId),
      sku: answer.sku ?? sku,
      token: answer.token,
      transactionId: answer.transactionId,
      amount: answer.amount,
      packageTitle: answer.packageTitle,
      gateway: answer.gateway,
      submittedAt: answer.submittedAt,
    };
  }

  /**
   * True when `token` is a payment of this player for this package that is paid and not consumed yet.
   * A paid payment must carry exactly this token (Pay itself would accept any token while one is paid).
   * When none is paid yet, Pay checks the token with the bank: a payment whose gateway callback was lost.
   */
  async verify(playerId: number, sku: string, token: string): Promise<boolean> {
    if (!token?.trim()) return false;
    const payment = await this.find(playerId, sku);
    if (payment) return payment.token === token;
    const answer = await this.call('payVerify', '/verify_payment', { uid: playerId, sku, pname: this.packageName, token });
    return answer.success === true || notValidOrThrow(answer, 'payVerify', false);
  }

  /**
   * Marks the paid payment of this package as delivered, so the player can buy it again. Call it after
   * your grant is saved. False when there was nothing to consume (already consumed).
   */
  async consume(playerId: number, sku: string): Promise<boolean> {
    const outcome = { resentAfterUnknownOutcome: false };
    const answer = await this.call('payConsume', '/consume', { uid: playerId, sku, pname: this.packageName }, outcome);
    if (answer.success === true) return true;
    // An attempt reached Pay without an answer and the retry found nothing left: the first one consumed it.
    if (answer.error === NOT_VALID && outcome.resentAfterUnknownOutcome) return true;
    return notValidOrThrow(answer, 'payConsume', false);
  }

  private async call(
    operation: string,
    path: string,
    body: Record<string, unknown>,
    outcome?: { resentAfterUnknownOutcome: boolean },
  ): Promise<WirePayAnswer> {
    // Every Pay call is safe to repeat: two reads, and a consume that finds nothing the second time.
    const answer = await this.transport.request<WirePayAnswer | null>({
      operation,
      method: 'POST',
      path,
      body,
      auth: 'none',
      idempotent: true,
      outcome,
    });
    return answer ?? {};
  }
}

/** `payment_is_not_valid` is an answer (`fallback`); any other Pay error (unknown app, `unexpected`) throws. */
function notValidOrThrow<T>(answer: WirePayAnswer, operation: string, fallback: T): T {
  if (answer.error === NOT_VALID) return fallback;
  const code = answer.error ?? 'unexpected';
  const hint = code === 'no_required_params' ? ' (is the package name registered in Baziness Pay?)' : '';
  throw new BazinessError(`${operation}: Baziness Pay answered ${code}${hint}`, operation, 200, code);
}
