package com.baziness.server;

/** Input of {@link Players#signIn}: who the device is and what it arrived with. */
public final class SignInRequest {
    /** Your stable id for this install (the device id your game generated on first launch). */
    public final String deviceId;
    /** {@code Android}, {@code Ios}, {@code Web}, {@code Editor}, … */
    public final String platform;
    /** {@code Direct}, {@code GooglePlay}, {@code AppStore}, {@code CafeBazaar} or {@code Myket}. */
    public final String store;
    /** The Baziness user id you already saved for this player; 0 for none. */
    public long userId;
    /** One-time code the player arrived with ({@code ?linkCode=} / deep link): joins them to that person. */
    public String linkCode;
    /** First-open attribution from the device SDK. */
    public Attribution attribution;

    public SignInRequest(String deviceId, String platform, String store) {
        if (deviceId == null || deviceId.trim().isEmpty()) {
            throw new IllegalArgumentException("deviceId is required");
        }
        this.deviceId = deviceId;
        this.platform = platform;
        this.store = store;
    }

    public SignInRequest userId(long userId) {
        this.userId = userId;
        return this;
    }

    public SignInRequest linkCode(String linkCode) {
        this.linkCode = linkCode;
        return this;
    }

    public SignInRequest attribution(Attribution attribution) {
        this.attribution = attribution;
        return this;
    }
}
