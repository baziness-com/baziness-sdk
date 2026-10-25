package com.baziness.server;

import java.util.Map;

/**
 * The Baziness SDK for game servers (Java 8+, no dependencies). One instance per process; it is
 * thread-safe. Calls block, so make them from a worker thread, not from a network I/O thread.
 *
 * <pre>
 * BazinessServer baziness = BazinessServer.builder(Environment.STAGING, clientId, clientSecret)
 *         .refreshTokens(myStore)
 *         .build();
 * SignInResult session = baziness.players().signIn(new SignInRequest(deviceId, "Android", "CafeBazaar").userId(saved));
 * </pre>
 */
public final class BazinessServer {
    public static final String SDK_VERSION = "1.0.0";

    private final Environment environment;
    private final String apiBase;
    private final Players players;
    private final Coins coins;
    private final Purchases purchases;
    private final ServerAnalytics analytics;
    private final Quests quests;

    private BazinessServer(Builder builder) {
        this.environment = builder.environment;
        String base = builder.apiBaseUrl != null && !builder.apiBaseUrl.trim().isEmpty()
                ? builder.apiBaseUrl.trim() : builder.environment.apiUrl();
        this.apiBase = base.replaceAll("/+$", "");
        if (builder.environment == Environment.PRODUCTION && builder.apiBaseUrl != null) {
            builder.logger.warn("[baziness] production with an API override: " + apiBase);
        }
        Transport transport = new Transport(apiBase, builder.http, builder.logger);
        transport.useClientToken(new ClientAuth(transport, builder.clientId, builder.clientSecret));
        this.analytics = new ServerAnalytics(transport, builder.logger, builder.analytics);
        this.players = new Players(transport, builder.refreshTokens, analytics, builder.logger);
        this.coins = new Coins(transport);
        this.purchases = new Purchases(transport, analytics);
        this.quests = new Quests(transport);
    }

    public static Builder builder(Environment environment, long clientId, String clientSecret) {
        return new Builder(environment, clientId, clientSecret);
    }

    /**
     * Reads {@code BAZINESS_ENVIRONMENT} ({@code staging} | {@code production}),
     * {@code BAZINESS_CLIENT_ID}, {@code BAZINESS_CLIENT_SECRET} and optionally
     * {@code BAZINESS_API_BASE_URL}, e.g. from {@code System.getenv()}.
     */
    public static Builder fromEnv(Map<String, String> env) {
        String environment = env.get("BAZINESS_ENVIRONMENT");
        String clientId = env.get("BAZINESS_CLIENT_ID");
        long id;
        try {
            id = Long.parseLong(clientId == null ? "" : clientId.trim());
        } catch (NumberFormatException e) {
            throw new IllegalArgumentException("BAZINESS_CLIENT_ID must be the numeric client id");
        }
        Builder builder = new Builder(Environment.parse(environment == null ? "staging" : environment), id,
                env.get("BAZINESS_CLIENT_SECRET"));
        builder.apiBaseUrl = env.get("BAZINESS_API_BASE_URL");
        return builder;
    }

    public Environment environment() {
        return environment;
    }

    public String apiBase() {
        return apiBase;
    }

    public Players players() {
        return players;
    }

    public Coins coins() {
        return coins;
    }

    public Purchases purchases() {
        return purchases;
    }

    public ServerAnalytics analytics() {
        return analytics;
    }

    public Quests quests() {
        return quests;
    }

    /** Ends open sessions and sends the remaining analytics. Call it on shutdown. */
    public void close() {
        analytics.close(5000);
    }

    public static final class Builder {
        private final Environment environment;
        private final long clientId;
        private final String clientSecret;
        private RefreshTokenStore refreshTokens;
        private String apiBaseUrl;
        private HttpOptions http = new HttpOptions();
        private AnalyticsOptions analytics = new AnalyticsOptions();
        private BazinessLogger logger = BazinessLogger.JUL;

        private Builder(Environment environment, long clientId, String clientSecret) {
            if (environment == null) {
                throw new IllegalArgumentException("environment is required");
            }
            if (clientId <= 0) {
                throw new IllegalArgumentException("clientId must be the positive client id of this environment");
            }
            if (clientSecret == null || clientSecret.trim().isEmpty()) {
                throw new IllegalArgumentException("clientSecret is required");
            }
            this.environment = environment;
            this.clientId = clientId;
            this.clientSecret = clientSecret;
        }

        /** Where each player's refresh token is kept. Required for signIn / session / logout. */
        public Builder refreshTokens(RefreshTokenStore store) {
            this.refreshTokens = store;
            return this;
        }

        /** Override the API root (a local platform stack, for example). */
        public Builder apiBaseUrl(String apiBaseUrl) {
            this.apiBaseUrl = apiBaseUrl;
            return this;
        }

        public Builder http(HttpOptions http) {
            this.http = http;
            return this;
        }

        public Builder analytics(AnalyticsOptions analytics) {
            this.analytics = analytics;
            return this;
        }

        public Builder logger(BazinessLogger logger) {
            this.logger = logger;
            return this;
        }

        public BazinessServer build() {
            return new BazinessServer(this);
        }
    }
}
