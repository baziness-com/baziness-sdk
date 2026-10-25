import { stableEventId, type ServerAnalytics } from './analytics.js';
import type { Transport } from './http.js';
import type { PaymentGateway } from './types.js';

export interface RecordPurchaseInput {
  userId: number;
  /** What the player paid, in `currency`. */
  amount: number;
  /** `IRT` (Toman, default) or `IRR` (rial). */
  currency?: 'IRT' | 'IRR';
  gateway: PaymentGateway;
  /** The payment company behind a `direct` checkout (zarinpal, idpay, …). Required for `direct`. */
  provider?: string;
  /** Store order id or purchase token. Makes the report idempotent: re-sending counts once. */
  orderId: string;
  sku?: string;
  occurredAt?: Date | string;
  /** Re-send with the same `orderId` and `refunded: true` when the store refunds it. */
  refunded?: boolean;
}

const GATEWAYS: ReadonlySet<string> = new Set(['cafebazaar', 'myket', 'googleplay', 'appstore', 'direct']);

/**
 * Revenue (step 5): every real-money purchase that did **not** go through Baziness Pay (which
 * reports its own). Only the game server reports purchases, after it has verified them with the
 * store; the device never does.
 */
export class Purchases {
  constructor(
    private readonly transport: Transport,
    private readonly analytics: ServerAnalytics,
  ) {}

  async record(input: RecordPurchaseInput): Promise<void> {
    if (!GATEWAYS.has(input.gateway)) {
      throw new TypeError(`purchases.record: unknown gateway "${input.gateway}"`);
    }
    if (input.gateway === 'direct' && !input.provider) {
      throw new TypeError('purchases.record: provider is required for direct checkouts');
    }
    if (!input.orderId?.trim()) {
      throw new TypeError('purchases.record: orderId is required (it makes the report idempotent)');
    }
    if (!(input.amount > 0)) {
      throw new RangeError('purchases.record: amount must be greater than zero');
    }
    const occurredAt = input.occurredAt instanceof Date ? input.occurredAt.toISOString() : input.occurredAt;
    await this.transport.request<void>({
      operation: 'recordPurchase',
      method: 'POST',
      path: '/analytics/record-purchase',
      body: {
        userId: input.userId,
        amount: input.amount,
        currency: input.currency ?? 'IRT',
        gateway: input.gateway,
        provider: input.provider,
        orderId: input.orderId,
        sku: input.sku,
        occurredAt,
        refunded: input.refunded ?? false,
      },
      auth: 'client',
      idempotent: true,
      expectJson: false,
    });
    if (!input.refunded) {
      const toman = input.currency === 'IRR' ? input.amount / 10 : input.amount;
      // The funnel event: the same order id makes it count once even when re-sent.
      this.analytics.track(input.userId, 'iap_purchase_completed', {
        eventId: stableEventId(`purchase:${input.gateway}:${input.orderId}`),
        value: toman,
        props: { sku: input.sku, gateway: input.gateway, order_id: input.orderId },
      });
    }
  }
}
