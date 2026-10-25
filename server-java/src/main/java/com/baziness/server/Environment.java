package com.baziness.server;

/**
 * The two Baziness environments. Integrate against {@link #STAGING} with the staging client id and
 * secret; switch to {@link #PRODUCTION} (and its keys) after the platform team's review.
 */
public enum Environment {
    STAGING("https://platform-dev.karizmastudios.org/api",
            "https://platform-web-dev.karizmastudios.org",
            "https://pay-dev.karizmastudios.org"),
    PRODUCTION("https://platform.karizmastudio.com/api",
            "https://baziness.com",
            "https://pay.baziness.com");

    private final String apiUrl;
    private final String pagesUrl;
    private final String payUrl;

    Environment(String apiUrl, String pagesUrl, String payUrl) {
        this.apiUrl = apiUrl;
        this.pagesUrl = pagesUrl;
        this.payUrl = payUrl;
    }

    public String apiUrl() {
        return apiUrl;
    }

    public String pagesUrl() {
        return pagesUrl;
    }

    public String payUrl() {
        return payUrl;
    }

    /** {@code staging} or {@code production}, case-insensitive. */
    public static Environment parse(String value) {
        if (value != null) {
            String name = value.trim();
            if (name.equalsIgnoreCase("staging")) {
                return STAGING;
            }
            if (name.equalsIgnoreCase("production")) {
                return PRODUCTION;
            }
        }
        throw new IllegalArgumentException("environment must be \"staging\" or \"production\", got \"" + value + "\"");
    }
}
