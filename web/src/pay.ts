
/** A payment the player completed on the Baziness Pay checkout page and your game has not consumed yet. */
export interface BazinessPayment {
  /** Your player id (Pay's `uid`). */
  playerId: number;
  sku: string;
  /** The payment's token: send it to your server, which verifies it and grants the package once. */
  token: string;
  transactionId?: string;
  /** What the player paid, in Toman. */
  amount?: number;
  packageTitle?: string;
  /** The bank gateway behind the checkout (`zarinpal`, `tara`, `snappPay`, …). */
  gateway?: string;
  submittedAt?: string;
}

/** Pay's answer when there is no such payment (not paid, not yet reported by the gateway, or consumed). */
const NOT_VALID = 'payment_is_not_valid';

/**
 * Baziness Pay, the web checkout for packages registered in Pay under your app's package name.
 *
 * 1. The player taps a package: show your "complete the purchase" dialog and call `openCheckout` in the
 *    same tap (browsers only allow a new tab from a tap).
 * 2. Back in the game, the player taps "Complete purchase": `findPayment`. `null` means not paid yet:
 *    keep the dialog so they can try again.
 * 3. Send the payment's token to your server. It verifies it with the server SDK (`pay.verify`), grants
 *    the package once per token and consumes it (`pay.consume`).
 *
 * Your server reports each granted payment to Baziness like any purchase (`purchases.record`, gateway
 * `baziness_pay`).
 */
export class BazinessPay {
  readonly payBase: string;

  constructor(
    payBase: string,
    /** Your app in Baziness Pay (Pay's `pname`). */
    readonly packageName: string,
    private readonly fetchImpl: typeof fetch,
  ) {
    if (!packageName) throw new TypeError('Baziness: the Pay package name is required');
    this.payBase = payBase.replace(/\/+$/, '');
  }

  /** The checkout page for this package. `playerId` is your player id, the same one your server verifies the payment with. */
  async checkoutUrl(sku: string, playerId: number): Promise<string> {
    if (!sku) throw new TypeError('Baziness: sku is required');
    const params = new URLSearchParams({ sku, uid: String(playerId), pname: this.packageName });
    return `${this.payBase}/buy?${params.toString()}`;
  }

  /**
   * Opens the checkout page in a new tab. Call it **in the player's tap** (before any `await`): the tab
   * opens at once and goes to the checkout when the address is ready. Returns the tab, or null when the
   * browser blocked it (then the page opens in this tab).
   */
  async openCheckout(sku: string, playerId: number): Promise<Window | null> {
    const tab = typeof window === 'undefined' ? null : window.open('about:blank', '_blank');
    if (tab) tab.opener = null;
    const url = await this.checkoutUrl(sku, playerId);
    if (tab) tab.location.href = url;
    else if (typeof location !== 'undefined') location.assign(url);
    return tab;
  }

  /**
   * The player's paid, unconsumed payment for this package, or `null` when there is none yet (not paid,
   * still on the bank's page, or already consumed). Throws when Pay cannot be reached or does not know
   * the package name.
   */
  async findPayment(sku: string, playerId: number): Promise<BazinessPayment | null> {
    const response = await this.fetchImpl(`${this.payBase}/get_payment`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ uid: playerId, sku, pname: this.packageName }),
    });
    if (!response.ok) throw new Error(`Baziness Pay: get_payment HTTP ${response.status}`);
    const answer = (await response.json()) as {
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
    };
    if (!answer.success) {
      if (answer.error === NOT_VALID) return null;
      const hint = answer.error === 'no_required_params' ? ` (is ${this.packageName} registered in Baziness Pay?)` : '';
      throw new Error(`Baziness Pay: get_payment answered ${answer.error ?? 'unexpected'}${hint}`);
    }
    if (!answer.token) throw new Error('Baziness Pay: get_payment sent a payment without a token');
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
}
