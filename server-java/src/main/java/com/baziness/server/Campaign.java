package com.baziness.server;

import java.util.Map;

/**
 * The install's campaign as Baziness knows it. An install that came with no campaign (no campaign
 * link, UTMs, store referrer or APK campaign) is {@code pending} for 24 hours after its first open;
 * asking with the device's fingerprint during that time matches it to the campaign link click it
 * most likely followed ({@code matchType} {@code probabilistic}). After that it is {@code organic}.
 * Text fields are empty, never null, when unknown.
 */
public final class Campaign {
    /** False: Baziness has nothing for this player yet (just created; ask again shortly). */
    public final boolean found;
    /** {@code pending}, {@code attributed}, {@code organic} or {@code legacy}. */
    public final String status;
    /** {@code deterministic} (link, store referrer, APK), {@code probabilistic} (fingerprint) or {@code none}. */
    public final String matchType;
    public final String channel;
    public final String utmSource;
    public final String utmMedium;
    public final String utmCampaign;
    public final String utmContent;
    public final String utmTerm;
    /** Campaign link code ({@code bz_lc}). */
    public final String campaignCode;
    public final String clickId;
    /** {@code googleplay}, {@code cafebazaar}, {@code myket}, {@code direct} or empty. */
    public final String installStore;
    /** ISO-8601 time of the install's first open, or null. */
    public final String firstSeen;
    /** ISO-8601 time the campaign was settled, or null while not attributed. */
    public final String attributedAt;

    private Campaign(Map<String, Object> wire) {
        found = Json.bool(wire, "found");
        status = text(wire, "status");
        matchType = text(wire, "matchType");
        channel = text(wire, "channel");
        utmSource = text(wire, "utmSource");
        utmMedium = text(wire, "utmMedium");
        utmCampaign = text(wire, "utmCampaign");
        utmContent = text(wire, "utmContent");
        utmTerm = text(wire, "utmTerm");
        campaignCode = text(wire, "linkCode");
        clickId = text(wire, "clickId");
        installStore = text(wire, "installStore");
        firstSeen = Json.string(wire, "firstSeen");
        attributedAt = Json.string(wire, "attributedAt");
    }

    static Campaign fromWire(Object answer) {
        return new Campaign(Json.object(answer));
    }

    /** True while Baziness may still settle the campaign: ask again later. */
    public boolean isPending() {
        return "pending".equals(status);
    }

    private static String text(Map<String, Object> wire, String key) {
        String value = Json.string(wire, key);
        return value == null ? "" : value;
    }
}
