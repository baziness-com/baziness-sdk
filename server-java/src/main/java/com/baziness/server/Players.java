package com.baziness.server;

import java.time.OffsetDateTime;
import java.util.LinkedHashMap;
import java.util.Map;

/**
 * Steps 2 and 3 of the flow: Baziness users for your players, their 15-minute access tokens, link
 * codes for Baziness pages, and verifying tokens that come back from a page.
 * <p>
 * Your server keeps no token: its client secret is enough to get a new access token for any of its
 * players ({@code v2/client/access-token}), so there is no refresh token to store, rotate or leak.
 */
public final class Players {
    private static final long MIN_TOKEN_LIFE_MS = 60000;
    private static final int MAX_CACHED_SESSIONS = 10000;
    private static final int LOCK_STRIPES = 64;

    /** A session including its refresh token: only the 1.0 low-level calls return it. */
    public static final class SessionWithRefreshToken extends PlayerSession {
        public final String refreshToken;
        public final String refreshTokenExpiresAt;

        SessionWithRefreshToken(long userId, boolean linked, String accessToken, String accessExpiresAt,
                                String refreshToken, String refreshExpiresAt) {
            super(userId, linked, accessToken, accessExpiresAt);
            this.refreshToken = refreshToken;
            this.refreshTokenExpiresAt = refreshExpiresAt;
        }
    }

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
    /** Only for integrations from 1.0, which kept refresh tokens: logout ends that leftover session. */
    private final RefreshTokenStore store;
    private final ServerAnalytics analytics;
    private final BazinessLogger logger;
    private final Object[] locks = new Object[LOCK_STRIPES];
    private final Map<Long, PlayerSession> cache = new LinkedHashMap<Long, PlayerSession>(256, 0.75f, true) {
        @Override
        protected boolean removeEldestEntry(Map.Entry<Long, PlayerSession> eldest) {
            return size() > MAX_CACHED_SESSIONS;
        }
    };

    Players(Transport transport, RefreshTokenStore store, ServerAnalytics analytics, BazinessLogger logger) {
        this.transport = transport;
        this.store = store;
        this.analytics = analytics;
        this.logger = logger;
        for (int i = 0; i < LOCK_STRIPES; i++) {
            locks[i] = new Object();
        }
    }

    // ── High level: what a game server calls ──

    /**
     * The one call for "a player's device came online". Creates the Baziness user the first time (or
     * when the player arrived with a link code), otherwise gets a fresh access token for them. Reports
     * {@code auth_login} when a user was created or joined through a link code.
     * <p>
     * Compare the returned {@code userId} with the one you saved: when it belongs to another of your
     * players, it is the same person on another device — switch this device to that player.
     */
    public SignInResult signIn(SignInRequest request) {
        boolean linkCodeRejected = false;
        boolean hasCode = request.linkCode != null && !request.linkCode.isEmpty();
        if (hasCode || request.userId <= 0) {
            try {
                return keep(createPlayer(request, request.linkCode),
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
                return keep(createPlayer(request, null), SignInResult.Method.CREATED, true);
            }
        }
        SignInResult result = session(request.userId);
        return new SignInResult(result, result.method, linkCodeRejected);
    }

    /**
     * A valid access token for a known player: the cached one while it has a minute left, otherwise a
     * new one (one request at a time per player in this process). Throws {@link BazinessException}
     * {@code account_suspended} (403) for a blocked account.
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
            return keep(accessToken(userId), SignInResult.Method.REFRESH, false);
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

    /**
     * The page sent {@code logout}: forget the player's cached token. A refresh token that an
     * integration from 1.0 still keeps in its store is revoked and removed.
     */
    public void logout(long userId) {
        synchronized (cache) {
            cache.remove(userId);
        }
        if (store == null) {
            return;
        }
        String refreshToken = store.get(userId);
        if (refreshToken != null) {
            try {
                revoke(refreshToken);
            } catch (BazinessException e) {
                logger.warn("[baziness] logout: " + e.getMessage());
            }
        }
        store.set(userId, null);
    }

    /** The player's Baziness account ({@code phoneNumber}, {@code fullName}, …), or null before they sign in. */
    public Map<String, Object> accountData(long userId) {
        Object answer = transport.request(
                new Transport.Call("accountData", "GET", "/client/account-data/" + userId, null, true, true));
        return answer == null ? null : Json.object(answer);
    }

    // ── Low level: one platform call each ──

    /**
     * {@code v2/client/access-token/{id}}: a 15-minute access token for one of your players, no
     * refresh token. Ask again when it runs out; {@link #session} caches it for you.
     */
    public PlayerSession accessToken(long userId) {
        // Issues a token and nothing else: safe to repeat.
        return fromAccessTokenSession(Json.object(transport.request(
                new Transport.Call("accessToken", "POST", "/v2/client/access-token/" + userId, null, true, true))));
    }

    /**
     * {@code v2/client/create-user} with a token pair (a refresh token you keep yourself). Kept for
     * integrations from 1.0; {@link #signIn} keeps no refresh token.
     */
    public SessionWithRefreshToken create(String deviceId, String platform, String store, String linkCode,
                                          Attribution attribution) {
        // Not idempotent: a retried create could consume the link code twice or create a second user.
        return fromUserSession(Json.object(transport.request(new Transport.Call("createUser", "POST",
                "/v2/client/create-user", createBody(deviceId, platform, store, linkCode, attribution), true, false))));
    }

    /** {@code v2/client/get-user-token/{id}}: a session with a refresh token (integrations from 1.0). */
    public SessionWithRefreshToken newSession(long userId) {
        return fromUserSession(Json.object(transport.request(
                new Transport.Call("newSession", "POST", "/v2/client/get-user-token/" + userId, null, true, false))));
    }

    /** {@code auth/refresh}: renews a session. The old refresh token stops working; keep the new one. */
    public SessionWithRefreshToken refresh(String refreshToken) {
        Map<String, Object> body = new LinkedHashMap<String, Object>();
        body.put("refreshToken", refreshToken);
        Map<String, Object> answer = Json.object(transport.request(
                new Transport.Call("refresh", "POST", "/auth/refresh", body, false, false)));
        return new SessionWithRefreshToken(Json.number(answer, "userId"), Json.bool(answer, "isLinkedToAccount"),
                Json.string(answer, "accessToken"), Json.string(answer, "accessTokenExpiresAt"),
                Json.string(answer, "refreshToken"), Json.string(answer, "refreshTokenExpiresAt"));
    }

    /** {@code auth/logout}: ends the session of this refresh token. */
    public void revoke(String refreshToken) {
        Map<String, Object> body = new LinkedHashMap<String, Object>();
        body.put("refreshToken", refreshToken);
        transport.request(new Transport.Call("logout", "POST", "/auth/logout", body, false, true).noJson());
    }

    // ── Internals ──

    /** {@code v2/client/create-user} with {@code accessTokenOnly}: the new user and an access token, nothing to keep. */
    private PlayerSession createPlayer(SignInRequest request, String linkCode) {
        Map<String, Object> body = createBody(request.deviceId, request.platform, request.store, linkCode,
                request.attribution);
        body.put("accessTokenOnly", Boolean.TRUE);
        // Not idempotent: a retried create could consume the link code twice or create a second user.
        return fromAccessTokenSession(Json.object(transport.request(
                new Transport.Call("createUser", "POST", "/v2/client/create-user", body, true, false))));
    }

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

    private static PlayerSession fromAccessTokenSession(Map<String, Object> answer) {
        return new PlayerSession(Json.number(answer, "userId"), Json.bool(answer, "isLinkedToAccount"),
                Json.string(answer, "token"), Json.string(answer, "accessTokenExpiresAt"));
    }

    private static SessionWithRefreshToken fromUserSession(Map<String, Object> answer) {
        Map<String, Object> tokens = Json.object(answer.get("tokens"));
        return new SessionWithRefreshToken(Json.number(answer, "userId"), Json.bool(answer, "isLinkedToAccount"),
                Json.string(tokens, "accessToken"), Json.string(tokens, "accessTokenExpiresAt"),
                Json.string(tokens, "refreshToken"), Json.string(tokens, "refreshTokenExpiresAt"));
    }

    private static long millisLeft(String isoTime) {
        try {
            return OffsetDateTime.parse(isoTime).toInstant().toEpochMilli() - System.currentTimeMillis();
        } catch (RuntimeException e) {
            return 0;
        }
    }
}
