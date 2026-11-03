namespace Baziness.Server;

/// <summary>
/// One real-money purchase your server verified. A Baziness Pay payment: gateway
/// <see cref="PaymentGateway.BazinessPay"/>, order id = the payment's token, provider = its bank
/// (<see cref="BazinessPayment.Gateway"/>) when you have it.
/// </summary>
public sealed class RecordPurchaseRequest
{
    public required long UserId { get; init; }

    /// <summary>What the player paid, in <see cref="Currency"/>.</summary>
    public required decimal Amount { get; init; }

    public required PaymentGateway Gateway { get; init; }

    /// <summary>Store order id or purchase token (Baziness Pay: the payment's token). Makes the report idempotent: re-sending counts once.</summary>
    public required string OrderId { get; init; }

    /// <summary><c>IRT</c> (Toman, default) or <c>IRR</c> (rial).</summary>
    public string Currency { get; init; } = "IRT";

    /// <summary>
    /// The payment company behind a <c>Direct</c> checkout (zarinpal, idpay, ...), required for <c>Direct</c>; for
    /// <c>BazinessPay</c>, the bank behind the checkout when you have it.
    /// </summary>
    public string? Provider { get; init; }

    public string? Sku { get; init; }
    public DateTimeOffset? OccurredAt { get; init; }

    /// <summary>Re-send with the same order id and this set when the store refunds it.</summary>
    public bool Refunded { get; init; }
}

/// <summary>
/// Revenue (step 5): every real-money purchase, Baziness Pay checkouts included: Baziness counts what game servers
/// report. Only the game server reports purchases, after it has verified them (with the store, or
/// <see cref="Pay.VerifyAsync"/> for a Baziness Pay payment); the device never does.
/// </summary>
public sealed class Purchases
{
    private readonly Transport _transport;
    private readonly ServerAnalytics _analytics;

    internal Purchases(Transport transport, ServerAnalytics analytics)
    {
        _transport = transport;
        _analytics = analytics;
    }

    public async Task RecordAsync(RecordPurchaseRequest purchase, CancellationToken cancellationToken = default)
    {
        ArgumentNullException.ThrowIfNull(purchase);

        var gateway = PaymentGateways.WireName(purchase.Gateway);
        if (purchase.Gateway == PaymentGateway.Direct && string.IsNullOrEmpty(purchase.Provider))
            throw new ArgumentException("purchases.record: provider is required for direct checkouts", nameof(purchase));
        if (string.IsNullOrWhiteSpace(purchase.OrderId))
            throw new ArgumentException("purchases.record: orderId is required (it makes the report idempotent)", nameof(purchase));
        if (purchase.Amount <= 0)
            throw new ArgumentOutOfRangeException(nameof(purchase), "purchases.record: amount must be greater than zero");

        await _transport.SendAsync(new RequestSpec("recordPurchase", HttpMethod.Post, "/analytics/record-purchase")
        {
            Body = new
            {
                userId = purchase.UserId,
                amount = purchase.Amount,
                currency = purchase.Currency,
                gateway,
                provider = purchase.Provider,
                orderId = purchase.OrderId,
                sku = purchase.Sku,
                occurredAt = purchase.OccurredAt is { } occurredAt ? PlatformTime.ToIso(occurredAt) : null,
                refunded = purchase.Refunded
            },
            Idempotent = true
        }, cancellationToken: cancellationToken).ConfigureAwait(false);

        if (purchase.Refunded)
            return;

        var toman = purchase.Currency == "IRR" ? purchase.Amount / 10 : purchase.Amount;
        // The funnel event: the same order id makes it count once even when re-sent.
        _analytics.Track(purchase.UserId, "iap_purchase_completed", new TrackOptions
        {
            EventId = ServerAnalytics.StableEventId($"purchase:{gateway}:{purchase.OrderId}"),
            Value = (double)toman,
            Props = new Dictionary<string, object?>
            {
                ["sku"] = purchase.Sku,
                ["gateway"] = gateway,
                ["order_id"] = purchase.OrderId
            }
        });
    }
}
