package com.baziness.server;

import java.util.LinkedHashMap;
import java.util.Map;

/**
 * First-touch attribution the device SDK collected on first open (landing UTMs, campaign link, store
 * referrer). The game server forwards it when it creates the player. Unset fields are left out.
 */
public final class Attribution {
    public String utmSource;
    public String utmMedium;
    public String utmCampaign;
    public String utmContent;
    public String utmTerm;
    /** Campaign link code ({@code bz_lc}). Not the sign-in link code. */
    public String campaignCode;
    /** Click id ({@code bz_click}) of that campaign link. */
    public String clickId;
    /** Raw install referrer (Google Play, Cafe Bazaar, Myket). */
    public String referrer;
    /** Android installer package, e.g. {@code com.farsitel.bazaar}. */
    public String installer;
    /** ISO time of the landing. */
    public String landedAt;

    /** Reads the JSON the device SDK sends ({@code null} or invalid JSON give an empty object). */
    public static Attribution fromJson(String json) {
        if (json == null || json.trim().isEmpty()) {
            return new Attribution();
        }
        try {
            return fromMap(Json.object(Json.parse(json)));
        } catch (IllegalArgumentException e) {
            return new Attribution();
        }
    }

    /** Reads the map the device SDK sends (its JSON field names). */
    public static Attribution fromMap(Map<String, ?> values) {
        Attribution attribution = new Attribution();
        if (values == null) {
            return attribution;
        }
        attribution.utmSource = text(values.get("utmSource"));
        attribution.utmMedium = text(values.get("utmMedium"));
        attribution.utmCampaign = text(values.get("utmCampaign"));
        attribution.utmContent = text(values.get("utmContent"));
        attribution.utmTerm = text(values.get("utmTerm"));
        attribution.campaignCode = text(values.get("campaignCode"));
        attribution.clickId = text(values.get("clickId"));
        attribution.referrer = text(values.get("referrer"));
        attribution.installer = text(values.get("installer"));
        attribution.landedAt = text(values.get("landedAt"));
        return attribution;
    }

    /** As {@code create-user} takes it, or null when nothing is set. */
    Map<String, Object> toWire() {
        Map<String, Object> wire = new LinkedHashMap<String, Object>();
        put(wire, "utmSource", utmSource);
        put(wire, "utmMedium", utmMedium);
        put(wire, "utmCampaign", utmCampaign);
        put(wire, "utmContent", utmContent);
        put(wire, "utmTerm", utmTerm);
        put(wire, "linkCode", campaignCode);
        put(wire, "clickId", clickId);
        put(wire, "referrer", referrer);
        put(wire, "installer", installer);
        put(wire, "landedAt", landedAt);
        return wire.isEmpty() ? null : wire;
    }

    private static void put(Map<String, Object> wire, String key, String value) {
        if (value != null && !value.isEmpty()) {
            wire.put(key, value);
        }
    }

    private static String text(Object value) {
        return value == null ? null : value.toString();
    }
}
