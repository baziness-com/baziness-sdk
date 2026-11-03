package com.baziness.server;

import java.nio.charset.StandardCharsets;
import java.time.Instant;
import java.time.OffsetDateTime;
import java.util.Base64;
import java.util.LinkedHashMap;
import java.util.Map;

/**
 * Steps 2 and 3 of the flow: Baziness users for your players, their tokens, link codes for Baziness
 * pages, and verifying tokens that come back from a page.
 * <p>
 * Your server stores no token: its client secret is enough to get any of its players' tokens
 * ({@code client/get-user-token}), and the SDK keeps them in memory.
 */
public final class Players {
    private static final long MIN_TOKEN_LIFE_MS = 60000;
    private static final int MAX_CACHED_SESSIONS = 10000;
    private static final int LOCK_STRIPES = 64;
    /** When a token's expiry can't be read: player tokens live for years. */
    private static final long LONG_LIVED_FALLBACK_MS = 365L * 86400000L;

    /** A code for opening a Baziness page as a player: works once, for about two minutes. */
    public static final class LinkCode {
        public final String code;
        public final String expiresAt;

        LinkCode(String code, String expiresAt) {
            this.code = code;
            this.expiresAt = expiresAt;
        }
    }

    /** The result of checking a token from a device. */
    public static final class VerifiedToken {
        public final boolean valid;
        /** The Baziness user the token belongs to; 0 when not valid. */
        public final long userId;

        VerifiedToken(boolean valid, long userId) {
            this.valid = valid;
            this.userId = userId;
        }
    }

    private final Transport transport;
    private final ServerAnalytics analytics;
    private final BazinessLogger logger;
    private final Object[] locks = new Object[LOCK_STRIPES];
    private final Map<Long, PlayerSession> cache = new LinkedHashMap<Long, PlayerSession>(256, 0.75f, true) {
        @Override
        protected boolean removeEldestEntry(Map.Entry<Long, PlayerSession> eldest) {
            return size() > MAX_CACHED_SESSIONS;
        }
    };

    Players(Transport transport, ServerAnalytics analytics, BazinessLogger logger) {
        this.transport = transport;
        this.analytics = analytics;
        this.logger = logger;
        for (int i = 0; i < LOCK_STRIPES; i++) {
            locks[i] = new Object();
        }
    }

    // ── High level: what a game server calls ──

    /**
     * The one call for "a player's device came online". Creates the Baziness user the first time (or
     * when the player arrived with a link code), otherwise gets the player's token. Reports
     * {@code auth_login} when a user was created or joined through a link code. Asks the platform every
     * time: what comes back also says whether the player has linked an account or been blocked since,
     * which the token staying valid does not show.
     * <p>
     * Compare the returned {@code userId} with the one you saved: when it belongs to another of your
     * players, it is the same person on another device — switch this device to that player.
     */
    public SignInResult signIn(SignInRequest request) {
        boolean linkCodeRejected = false;
        boolean hasCode = request.linkCode != null && !request.linkCode.isEmpty();
        if (hasCode || request.userId <= 0) {
            try {
                return keep(create(request.deviceId, request.platform, request.store, request.linkCode, request.attribution),
                        hasCode ? SignInResult.Method.LINK_CODE : SignInResult.Method.CREATED, false);
            } catch (BazinessException e) {
                if (!(hasCode && e.hasCode(BazinessException.INVALID_LINK_CODE))) {
                    throw e;
                }
                // Expired, already used or meant for another game: carry on as if no code was sent.
                linkCodeRejected = true;
                logger.info("[baziness] link code rejected; continuing without it");
            }
            if (request.userId <= 0) {
                return keep(create(request.deviceId, request.platform, request.store, null, request.attribution),
                        SignInResult.Method.CREATED, true);
            }
        }
        SignInResult result;
        synchronized (locks[(int) (Math.abs(request.userId) % LOCK_STRIPES)]) {
            result = keep(token(request.userId), SignInResult.Method.REFRESH, false);
        }
        return new SignInResult(result, result.method, linkCodeRejected);
    }

    /**
     * The token of a known player: the cached one, otherwise the platform's (one request at a time
     * per player in this process). Throws {@link BazinessException} {@code account_suspended} (403)
     * for a blocked account.
     */
    public SignInResult session(long userId) {
        synchronized (locks[(int) (Math.abs(userId) % LOCK_STRIPES)]) {
            PlayerSession cached;
            synchronized (cache) {
                cached = cache.get(userId);
            }
            if (cached != null && millisLeft(cached.accessTokenExpiresAt) > MIN_TOKEN_LIFE_MS) {
                return new SignInResult(cached, SignInResult.Method.REFRESH, false);
            }
            return keep(token(userId), SignInResult.Method.REFRESH, false);
        }
    }

    /** A link code for opening a Baziness page as this player. Get a new one for every page. */
    public LinkCode linkCode(long userId) {
        Map<String, Object> answer = Json.object(transport.request(
                new Transport.Call("linkCode", "POST", "/v2/client/link-code/" + userId, null, true, true)));
        return new LinkCode(Json.string(answer, "code"), Json.string(answer, "expiresAt"));
    }

    /**
     * Check a token that came from a device (the {@code login} message of a Baziness page) before
     * acting on it. Invalid or expired tokens give {@code valid = false, userId = 0}, not an error.
     */
    public VerifiedToken verifyToken(String token) {
        Map<String, Object> body = new LinkedHashMap<String, Object>();
        body.put("token", token);
        Map<String, Object> answer = Json.object(transport.request(
                new Transport.Call("verifyToken", "POST", "/client/validate-user-token", body, true, true)));
        boolean valid = Json.bool(answer, "isValid") && Json.number(answer, "userId") > 0;
        return new VerifiedToken(valid, valid ? Json.number(answer, "userId") : 0);
    }

    /** The page sent {@code logout}: forget the player's cached token. */
    public void logout(long userId) {
        synchronized (cache) {
            cache.remove(userId);
        }
    }

    /**
     * The Baziness user id of your player who signed in with this phone number, or 0 when none of your
     * players did (for example to reward a phone number a campaign or partner sends you).
     */
    public long findByPhone(String phoneNumber) {
        if (phoneNumber == null || phoneNumber.trim().isEmpty()) {
            throw new IllegalArgumentException("players.findByPhone: phoneNumber is required");
        }
        Map<String, Object> answer = Json.object(transport.request(new Transport.Call("checkPhoneNumber", "GET",
                "/client/check-phone-number/" + Transport.encodePath(phoneNumber.trim()), null, true, true)));
        return Json.bool(answer, "isRegistered") ? Json.number(answer, "userId") : 0;
    }

    /**
     * Your player's install campaign. Pass the device as your server saw it (IP and User-Agent of the
     * player's request, model and OS version from the device SDK): while the install is still pending
     * (24 h after its first open, when it came with no campaign) Baziness first matches it by that
     * fingerprint to the campaign link click it most likely followed ({@code matchType}
     * {@code probabilistic}). Ask when the player opens the game; the answer is final once it is no
     * longer pending. 403 for another game's player.
     */
    public Campaign campaign(long userId, DeviceFingerprint device) {
        Map<String, Object> body = device == null ? new java.util.LinkedHashMap<String, Object>() : device.toWire();
        // Asking again answers the same: a click wins one install, and the first answer is final.
        return Campaign.fromWire(transport.request(
                new Transport.Call("campaign", "POST", "/v2/client/attribution/" + userId, body, true, true)));
    }

    /** {@link #campaign(long, DeviceFingerprint)} without a device: the campaign as it stands, no matching. */
    public Campaign campaign(long userId) {
        return campaign(userId, null);
    }

    /** The player's Baziness account ({@code phoneNumber}, {@code fullName}, …), or null before they sign in. */
    public Map<String, Object> accountData(long userId) {
        Object answer = transport.request(
                new Transport.Call("accountData", "GET", "/client/account-data/" + userId, null, true, true));
        return answer == null ? null : Json.object(answer);
    }

    // ── Low level: one platform call each ──

    /**
     * {@code client/create-user}: a new Baziness user for this install, or, with a link code, the
     * user of the person it stands for in your game. Answers the player's token.
     */
    public PlayerSession create(String deviceId, String platform, String store, String linkCode,
                                Attribution attribution) {
        // Not idempotent: a retried create could consume the link code twice or create a second user.
        return fromUserAuth(Json.object(transport.request(new Transport.Call("createUser", "POST",
                "/client/create-user", createBody(deviceId, platform, store, linkCode, attribution), true, false))));
    }

    /** {@code client/get-user-token/{id}}: the token of one of your players. */
    public PlayerSession token(long userId) {
        return fromUserAuth(Json.object(transport.request(
                new Transport.Call("userToken", "GET", "/client/get-user-token/" + userId, null, true, true))));
    }

    // ── Internals ──

    private static Map<String, Object> createBody(String deviceId, String platform, String store, String linkCode,
                                                  Attribution attribution) {
        Map<String, Object> body = new LinkedHashMap<String, Object>();
        body.put("deviceId", deviceId);
        body.put("platform", platform);
        body.put("store", store);
        body.put("linkCode", linkCode == null || linkCode.isEmpty() ? null : linkCode);
        body.put("attribution", attribution == null ? null : attribution.toWire());
        return body;
    }

    private SignInResult keep(PlayerSession session, SignInResult.Method method, boolean linkCodeRejected) {
        PlayerSession result = new PlayerSession(session.userId, session.isLinkedToAccount, session.accessToken,
                session.accessTokenExpiresAt);
        synchronized (cache) {
            cache.put(session.userId, result);
        }
        if (method != SignInResult.Method.REFRESH) {
            Map<String, Object> props = new LinkedHashMap<String, Object>();
            props.put("method", method.wireName);
            props.put("linked", session.isLinkedToAccount);
            props.put("link_code_rejected", linkCodeRejected ? Boolean.TRUE : null);
            analytics.track(session.userId, "auth_login", new ServerAnalytics.Event().props(props));
        }
        return new SignInResult(result, method, linkCodeRejected);
    }

    private static PlayerSession fromUserAuth(Map<String, Object> answer) {
        String token = Json.string(answer, "token");
        return new PlayerSession(Json.number(answer, "userId"), Json.bool(answer, "isLinkedToAccount"),
                token, tokenExpiry(token));
    }

    /** The token's own {@code exp} (ISO). Read without checking the signature: the platform checks that. */
    private static String tokenExpiry(String token) {
        try {
            String[] parts = token.split("\\.");
            Object exp = Json.object(Json.parse(new String(Base64.getUrlDecoder().decode(parts[1]),
                    StandardCharsets.UTF_8))).get("exp");
            if (exp instanceof Number) {
                return Instant.ofEpochSecond(((Number) exp).longValue()).toString();
            }
        } catch (RuntimeException e) {
            // Not a JWT we can read: treat it as long-lived, like every player token.
        }
        return Instant.ofEpochMilli(System.currentTimeMillis() + LONG_LIVED_FALLBACK_MS).toString();
    }

    private static long millisLeft(String isoTime) {
        try {
            return OffsetDateTime.parse(isoTime).toInstant().toEpochMilli() - System.currentTimeMillis();
        } catch (RuntimeException e) {
            return 0;
        }
    }
}
