package com.baziness.server;

import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.LinkedHashMap;
import java.util.Map;

/** Gita coins (step 4): give coins to your players and read their balance. */
public final class Coins {
    /** The outcome of {@link #add}. */
    public static final class AddResult {
        /** Coins credited by this call (the platform answers with the amount, not the balance); null when already credited. */
        public final Long credited;
        /** The platform had credited this transaction id before: treat it as paid. */
        public final boolean alreadyCredited;
        public final String transactionId;

        AddResult(Long credited, boolean alreadyCredited, String transactionId) {
            this.credited = credited;
            this.alreadyCredited = alreadyCredited;
            this.transactionId = transactionId;
        }
    }

    private final Transport transport;

    Coins(Transport transport) {
        this.transport = transport;
    }

    /**
     * Credit coins. {@code grantKey} says what this payout <b>is</b> ({@code match:17},
     * {@code reward_claim:42}, …): the same payout always gives the same transaction id, so a retry,
     * a double tap or a crash never pays twice. An id the platform already credited comes back as
     * {@code alreadyCredited} instead of an error. {@code metadata} (any map) is stored with it.
     */
    public AddResult add(long userId, long amount, String grantKey, Map<String, ?> metadata) {
        if (grantKey == null || grantKey.isEmpty()) {
            throw new IllegalArgumentException("coins.add: grantKey is required so the payout cannot be paid twice");
        }
        return addWithTransactionId(userId, amount, transactionIdFor(userId, amount, grantKey), metadata);
    }

    /** Like {@link #add} with your own unique transaction id. */
    public AddResult addWithTransactionId(long userId, long amount, String transactionId, Map<String, ?> metadata) {
        if (amount <= 0) {
            throw new IllegalArgumentException("coins.add: amount must be positive");
        }
        Map<String, Object> body = new LinkedHashMap<String, Object>();
        body.put("userId", userId);
        body.put("amount", amount);
        body.put("transactionId", transactionId);
        body.put("metaData", metadata);
        try {
            Map<String, Object> answer = Json.object(transport.request(
                    new Transport.Call("addCoin", "POST", "/client/add-coin", body, true, true)));
            return new AddResult(Json.number(answer, "amount"), false, transactionId);
        } catch (BazinessException e) {
            if (e.status() == 400 && e.code() != null && e.code().toLowerCase().contains("add resource failed")) {
                return new AddResult(null, true, transactionId);
            }
            throw e;
        }
    }

    /** A player's Gita coin balance. */
    public long balance(long userId) {
        Map<String, Object> answer = Json.object(transport.request(
                new Transport.Call("getCoin", "GET", "/client/get-coin/" + userId, null, true, true)));
        return Json.number(answer, "amount");
    }

    /** {@code <userId>_<amount>_<first 24 hex chars of sha1(grantKey)>}, the platform's convention. */
    public static String transactionIdFor(long userId, long amount, String grantKey) {
        try {
            byte[] digest = MessageDigest.getInstance("SHA-1").digest(grantKey.getBytes(StandardCharsets.UTF_8));
            StringBuilder hex = new StringBuilder();
            for (int i = 0; i < 12; i++) {
                hex.append(String.format("%02x", digest[i] & 0xff));
            }
            return userId + "_" + amount + "_" + hex;
        } catch (NoSuchAlgorithmException e) {
            throw new IllegalStateException(e);
        }
    }
}
