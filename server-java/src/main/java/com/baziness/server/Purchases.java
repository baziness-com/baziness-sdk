package com.baziness.server;

import java.util.Arrays;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.Set;

/**
 * Revenue (step 5): every real-money purchase that did <b>not</b> go through Baziness Pay (which
 * reports its own). Only the game server reports purchases, after verifying them with the store.
 */
public final class Purchases {
    private static final Set<String> GATEWAYS = new HashSet<String>(
            Arrays.asList("cafebazaar", "myket", "googleplay", "appstore", "direct"));

    /** One purchase. Required: userId, amount, gateway, orderId; provider for {@code direct}. */
    public static final class Purchase {
        public final long userId;
        public final double amount;
        public final String gateway;
        public final String orderId;
        /** {@code IRT} (Toman, default) or {@code IRR} (rial). */
        public String currency = "IRT";
        public String provider;
        public String sku;
        /** ISO time. */
        public String occurredAt;
        public boolean refunded;

        public Purchase(long userId, double amount, String gateway, String orderId) {
            this.userId = userId;
            this.amount = amount;
            this.gateway = gateway;
            this.orderId = orderId;
        }

        public Purchase sku(String sku) {
            this.sku = sku;
            return this;
        }

        public Purchase provider(String provider) {
            this.provider = provider;
            return this;
        }

        public Purchase currency(String currency) {
            this.currency = currency;
            return this;
        }

        public Purchase refunded(boolean refunded) {
            this.refunded = refunded;
            return this;
        }
    }

    private final Transport transport;
    private final ServerAnalytics analytics;

    Purchases(Transport transport, ServerAnalytics analytics) {
        this.transport = transport;
        this.analytics = analytics;
    }

    public void record(Purchase purchase) {
        if (!GATEWAYS.contains(purchase.gateway)) {
            throw new IllegalArgumentException("purchases.record: unknown gateway \"" + purchase.gateway + "\"");
        }
        if ("direct".equals(purchase.gateway) && (purchase.provider == null || purchase.provider.isEmpty())) {
            throw new IllegalArgumentException("purchases.record: provider is required for direct checkouts");
        }
        if (purchase.orderId == null || purchase.orderId.trim().isEmpty()) {
            throw new IllegalArgumentException("purchases.record: orderId is required (it makes the report idempotent)");
        }
        if (!(purchase.amount > 0)) {
            throw new IllegalArgumentException("purchases.record: amount must be greater than zero");
        }
        Map<String, Object> body = new LinkedHashMap<String, Object>();
        body.put("userId", purchase.userId);
        body.put("amount", purchase.amount);
        body.put("currency", purchase.currency);
        body.put("gateway", purchase.gateway);
        body.put("provider", purchase.provider);
        body.put("orderId", purchase.orderId);
        body.put("sku", purchase.sku);
        body.put("occurredAt", purchase.occurredAt);
        body.put("refunded", purchase.refunded);
        transport.request(new Transport.Call("recordPurchase", "POST", "/analytics/record-purchase", body, true, true).noJson());
        if (!purchase.refunded) {
            double toman = "IRR".equals(purchase.currency) ? purchase.amount / 10 : purchase.amount;
            // The funnel event: the same order id makes it count once even when re-sent.
            analytics.track(purchase.userId, "iap_purchase_completed", new ServerAnalytics.Event()
                    .eventId(ServerAnalytics.stableEventId("purchase:" + purchase.gateway + ":" + purchase.orderId))
                    .value(toman)
                    .prop("sku", purchase.sku)
                    .prop("gateway", purchase.gateway)
                    .prop("order_id", purchase.orderId));
        }
    }
}
