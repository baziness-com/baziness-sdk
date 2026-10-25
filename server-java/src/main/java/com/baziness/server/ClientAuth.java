package com.baziness.server;

import java.nio.charset.StandardCharsets;
import java.util.Base64;
import java.util.LinkedHashMap;
import java.util.Map;

/**
 * Step 1 of the flow: the game server proves who it is with its client id and secret and keeps the
 * client token in memory. Fetched on first use, renewed shortly before it expires and again after a
 * 401. Threads share one authentication.
 */
final class ClientAuth implements Transport.ClientTokenSupplier {
    private static final long RENEW_BEFORE_EXPIRY_MS = 60000;

    private final Transport transport;
    private final long clientId;
    private final String clientSecret;
    private String token;
    private long expiresAt = Long.MAX_VALUE;

    ClientAuth(Transport transport, long clientId, String clientSecret) {
        this.transport = transport;
        this.clientId = clientId;
        this.clientSecret = clientSecret;
    }

    @Override
    public synchronized String token(long deadlineAt, boolean forceNew) {
        if (token != null && !forceNew && System.currentTimeMillis() < expiresAt - RENEW_BEFORE_EXPIRY_MS) {
            return token;
        }
        Map<String, Object> body = new LinkedHashMap<String, Object>();
        body.put("clientId", clientId);
        body.put("clientSecret", clientSecret);
        Map<String, Object> answer = Json.object(transport.request(
                new Transport.Call("clientAuth", "POST", "/client/auth", body, false, true), deadlineAt));
        token = Json.string(answer, "token");
        if (token == null) {
            throw new BazinessException("clientAuth: no token in the answer", "clientAuth", 200, null);
        }
        Long expiry = jwtExpiry(token);
        expiresAt = expiry != null ? expiry : Long.MAX_VALUE;
        return token;
    }

    /** The {@code exp} of a JWT in epoch milliseconds, read without verifying it. */
    static Long jwtExpiry(String jwt) {
        String[] parts = jwt.split("\\.");
        if (parts.length < 2) {
            return null;
        }
        try {
            String payload = new String(Base64.getUrlDecoder().decode(parts[1]), StandardCharsets.UTF_8);
            Object exp = Json.object(Json.parse(payload)).get("exp");
            return exp instanceof Number ? ((Number) exp).longValue() * 1000 : null;
        } catch (IllegalArgumentException e) {
            return null;
        }
    }
}
