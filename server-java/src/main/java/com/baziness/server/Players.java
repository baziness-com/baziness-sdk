package com.baziness.server;

import java.time.OffsetDateTime;
import java.util.Arrays;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.Set;

/**
 * Steps 2 and 3 of the flow: Baziness users for your players, their sessions (15-minute access
 * tokens renewed with refresh tokens kept on your server), link codes for Baziness pages, and
 * verifying tokens that come back from a page.
 */
public final class Players {
    private static final Set<String> SESSION_OVER = new HashSet<String>(Arrays.asList(
            "session_revoked", "refresh_token_expired", "invalid_refresh_token", "refresh_token_reused"));
    private static final long MIN_TOKEN_LIFE_MS = 60000;
    private static final int MAX_CACHED_SESSIONS = 10000;
    private static final int LOCK_STRIPES = 64;

    /** A session including its refresh token: only the low-level calls return it. */
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
     * when the player arrived with a link code), otherwise renews their session. Saves the newest
     * refresh token in your store and reports {@code auth_login}.
     * <p>
     * Compare the returned {@code userId} with the one you saved: when it belongs to another of your
     * players, it is the same person on another device — switch this device to that player.
     */
    public SignInResult signIn(SignInRequest request) {
        requireStore();
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
        SignInResult result = session(request.userId);
        return new SignInResult(result, result.method, linkCodeRejected);
    }

    /**
     * A valid access token for a known player: the cached one while it has a minute left, otherwise
     * a refresh (one at a time per player in this process). Falls back to a new session when the
     * refresh token is missing or the session ended. Throws {@link BazinessException}
     * {@code account_suspended} (403) for a blocked account.
     */
    public SignInResult session(long userId) {
        requireStore();
        synchronized (locks[(int) (Math.abs(userId) % LOCK_STRIPES)]) {
            PlayerSession cached;
            synchronized (cache) {
                cached = cache.get(userId);
            }
            if (cached != null && millisLeft(cached.accessTokenExpiresAt) > MIN_TOKEN_LIFE_MS) {
                return new SignInResult(cached, SignInResult.Method.REFRESH, false);
            }
            String saved = store.get(userId);
            if (saved != null) {
                SessionWithRefreshToken refreshed = tryRefresh(userId, saved);
                if (refreshed != null) {
                    return keep(refreshed, SignInResult.Method.REFRESH, false);
                }
            }
            // No refresh token yet (a player from before the migration) or the session ended.
            return keep(newSession(userId), SignInResult.Method.NEW_SESSION, false);
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

    /** End the player's session (the page sent {@code logout}) and forget their refresh token. */
    public void logout(long userId) {
        requireStore();
        synchronized (cache) {
            cache.remove(userId);
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

    // ── Low level: one platform call each; you keep the refresh token yourself ──

    /** {@code v2/client/create-user}. */
    public SessionWithRefreshToken create(String deviceId, String platform, String store, String linkCode,
                                          Attribution attribution) {
        Map<String, Object> body = new LinkedHashMap<String, Object>();
        body.put("deviceId", deviceId);
        body.put("platform", platform);
        body.put("store", store);
        body.put("linkCode", linkCode == null || linkCode.isEmpty() ? null : linkCode);
        body.put("attribution", attribution == null ? null : attribution.toWire());
        // Not idempotent: a retried create could consume the link code twice or create a second user.
        return fromUserSession(Json.object(transport.request(
                new Transport.Call("createUser", "POST", "/v2/client/create-user", body, true, false))));
    }

    /** {@code v2/client/get-user-token/{id}}: a new session for a known player. */
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

    private SessionWithRefreshToken tryRefresh(long userId, String refreshToken) {
        try {
            return refresh(refreshToken);
        } catch (BazinessException e) {
            if (e.hasCode(BazinessException.REFRESH_TOKEN_ROTATED)) {
                // Another server instance refreshed this player a moment ago: wait for it to save
                // the newest token, then renew with that one.
                for (int attempt = 1; attempt <= 3; attempt++) {
                    Transport.sleep(150L * attempt);
                    String latest = store.get(userId);
                    if (latest != null && !latest.equals(refreshToken)) {
                        try {
                            return refresh(latest);
                        } catch (BazinessException retry) {
                            if (sessionOver(retry) || retry.hasCode(BazinessException.REFRESH_TOKEN_ROTATED)) {
                                return null;
                            }
                            throw retry;
                        }
                    }
                }
                return null;
            }
            if (sessionOver(e)) {
                return null;
            }
            throw e;
        }
    }

    private SignInResult keep(SessionWithRefreshToken session, SignInResult.Method method, boolean linkCodeRejected) {
        // Always the newest refresh token: the previous one stops working.
        store.set(session.userId, session.refreshToken);
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

    private static SessionWithRefreshToken fromUserSession(Map<String, Object> answer) {
        Map<String, Object> tokens = Json.object(answer.get("tokens"));
        return new SessionWithRefreshToken(Json.number(answer, "userId"), Json.bool(answer, "isLinkedToAccount"),
                Json.string(tokens, "accessToken"), Json.string(tokens, "accessTokenExpiresAt"),
                Json.string(tokens, "refreshToken"), Json.string(tokens, "refreshTokenExpiresAt"));
    }

    private static boolean sessionOver(BazinessException e) {
        return e.code() != null && SESSION_OVER.contains(e.code());
    }

    private static long millisLeft(String isoTime) {
        try {
            return OffsetDateTime.parse(isoTime).toInstant().toEpochMilli() - System.currentTimeMillis();
        } catch (RuntimeException e) {
            return 0;
        }
    }

    private void requireStore() {
        if (store == null) {
            throw new IllegalStateException("BazinessServer: set refreshTokens (a RefreshTokenStore) to use player sessions");
        }
    }
}
