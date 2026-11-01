package com.baziness.server;

import java.util.LinkedHashMap;
import java.util.Map;

/**
 * Baziness Pay: the web checkout ({@code pay.baziness.com}) for packages registered in Pay under your
 * app's package name. Pay reports these payments to Baziness itself: never {@code purchases().record}
 * them.
 *
 * <p>The flow: the device opens the checkout page (device SDK {@code OpenCheckout}), the player pays and
 * comes back to the game, taps "Complete purchase", the device finds the payment and sends its token to
 * your server. Your server checks it with {@link #verify}, grants the package once per token, then calls
 * {@link #consume} so the player can buy the same package again.
 *
 * <pre>
 * Pay pay = baziness.pay("com.example.game");
 * if (pay.verify(playerId, sku, token)) {
 *     grantOnce(playerId, sku, token); // your own idempotent grant, keyed by the token
 *     pay.consume(playerId, sku);
 * }
 * </pre>
 */
public final class Pay {
    /** Pay's answer when there is no such payment (not paid, not yet reported by the gateway, or consumed). */
    private static final String NOT_VALID = "payment_is_not_valid";

    /** A payment the player completed on the checkout page and your game has not consumed yet. */
    public static final class Payment {
        /** Your player id (Pay's {@code uid}). */
        public final long playerId;
        public final String sku;
        /** The payment's token: what your server checks with {@link #verify} and keeps to grant it once. */
        public final String token;
        public final String transactionId;
        /** What the player paid, in Toman; 0 when Pay did not say. */
        public final long amount;
        public final String packageTitle;
        /** The bank gateway behind the checkout ({@code zarinpal}, {@code tara}, {@code snappPay}, …). */
        public final String gateway;
        public final String submittedAt;

        Payment(long playerId, String sku, String token, String transactionId, long amount, String packageTitle,
                String gateway, String submittedAt) {
            this.playerId = playerId;
            this.sku = sku;
            this.token = token;
            this.transactionId = transactionId;
            this.amount = amount;
            this.packageTitle = packageTitle;
            this.gateway = gateway;
            this.submittedAt = submittedAt;
        }
    }

    private final Transport transport;
    private final String packageName;

    Pay(Transport transport, String packageName) {
        if (packageName == null || packageName.trim().isEmpty()) {
            throw new IllegalArgumentException("pay: packageName is required (your app in Baziness Pay)");
        }
        this.transport = transport;
        this.packageName = packageName;
    }

    /** Your app's package name in Baziness Pay (Pay's {@code pname}). */
    public String packageName() {
        return packageName;
    }

    /**
     * The player's paid, unconsumed payment for this package, or null when there is none: not paid yet,
     * still on the bank's page, or already consumed. A server can complete a checkout with this alone,
     * without a token from the device.
     */
    public Payment find(long playerId, String sku) {
        Map<String, Object> answer = call(new Transport.Call("payFind", "POST", "/get_payment", body(playerId, sku, null), false, true));
        if (!Json.bool(answer, "success")) {
            notValidOrThrow(answer, "payFind");
            return null;
        }
        String token = Json.string(answer, "token");
        if (token == null) {
            throw new BazinessException("pay.find: Baziness Pay sent a payment without a token", "payFind", 200, null);
        }
        String answeredSku = Json.string(answer, "sku");
        return new Payment(answer.containsKey("uid") ? Json.number(answer, "uid") : playerId,
                answeredSku != null ? answeredSku : sku, token, Json.string(answer, "transactionId"),
                Json.number(answer, "amount"), Json.string(answer, "packageTitle"), Json.string(answer, "gateway"),
                Json.string(answer, "submittedAt"));
    }

    /**
     * True when {@code token} is a payment of this player for this package that is paid and not consumed
     * yet. A paid payment must carry exactly this token (Pay itself would accept any token while one is
     * paid). When none is paid yet, Pay checks the token with the bank: a payment whose gateway callback
     * was lost.
     */
    public boolean verify(long playerId, String sku, String token) {
        if (token == null || token.trim().isEmpty()) {
            return false;
        }
        Payment payment = find(playerId, sku);
        if (payment != null) {
            return payment.token.equals(token);
        }
        Map<String, Object> answer = call(new Transport.Call("payVerify", "POST", "/verify_payment", body(playerId, sku, token), false, true));
        if (Json.bool(answer, "success")) {
            return true;
        }
        notValidOrThrow(answer, "payVerify");
        return false;
    }

    /**
     * Marks the paid payment of this package as delivered, so the player can buy it again. Call it after
     * your grant is saved. False when there was nothing to consume (already consumed).
     */
    public boolean consume(long playerId, String sku) {
        Transport.Call call = new Transport.Call("payConsume", "POST", "/consume", body(playerId, sku, null), false, true);
        Map<String, Object> answer = call(call);
        if (Json.bool(answer, "success")) {
            return true;
        }
        // An attempt reached Pay without an answer and the retry found nothing left: the first one consumed it.
        if (NOT_VALID.equals(Json.string(answer, "error")) && call.resentAfterUnknownOutcome) {
            return true;
        }
        notValidOrThrow(answer, "payConsume");
        return false;
    }

    private Map<String, Object> body(long playerId, String sku, String token) {
        Map<String, Object> body = new LinkedHashMap<String, Object>();
        body.put("uid", playerId);
        body.put("sku", sku);
        body.put("pname", packageName);
        if (token != null) {
            body.put("token", token);
        }
        return body;
    }

    /**
     * Every Pay call is safe to repeat: two reads, and a consume that finds nothing the second time.
     * Streamed, so the JDK cannot resend one unseen when the connection drops before the answer.
     */
    private Map<String, Object> call(Transport.Call call) {
        return Json.object(transport.request(call.streamed()));
    }

    /** {@code payment_is_not_valid} is an answer; any other Pay error (unknown app, {@code unexpected}) throws. */
    private static void notValidOrThrow(Map<String, Object> answer, String operation) {
        String code = Json.string(answer, "error");
        if (NOT_VALID.equals(code)) {
            return;
        }
        if (code == null) {
            code = "unexpected";
        }
        String hint = "no_required_params".equals(code) ? " (is the package name registered in Baziness Pay?)" : "";
        throw new BazinessException(operation + ": Baziness Pay answered " + code + hint, operation, 200, code);
    }
}
