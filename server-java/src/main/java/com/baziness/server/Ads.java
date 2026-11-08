package com.baziness.server;

import java.util.LinkedHashMap;
import java.util.Map;

/** The sponsor ad assigned to this game, and its impressions and clicks. Server only. */
public final class Ads {
    private final Transport transport;

    Ads(Transport transport) {
        this.transport = transport;
    }

    /** The game's current ad, or null when none is assigned (204 or JSON null). Does not count a view. */
    public Ad get() {
        Object answer = transport.request(new Transport.Call("getAd", "GET", "/content/get-ad", null, true, true));
        if (answer == null) return null;
        Map<String, Object> value = Json.object(answer);
        long id = Json.number(value, "id");
        String title = Json.string(value, "title");
        String imageUrl = Json.string(value, "imageUrl");
        String link = Json.string(value, "link");
        if (id <= 0 || title == null || imageUrl == null || link == null) {
            throw new BazinessException("getAd: the platform sent an invalid ad", "getAd", 200, null);
        }
        return new Ad(id, title, imageUrl, link);
    }

    /** Call once when the player is shown this ad. userId is the Baziness user id, not the game's id. */
    public void seen(long adId, long userId) {
        track(adId, userId, "seen");
    }

    /** Call once when the player clicks the ad they were shown. Not automatically called by get(). */
    public void click(long adId, long userId) {
        track(adId, userId, "click");
    }

    private void track(long adId, long userId, String eventType) {
        if (adId <= 0 || userId <= 0) throw new IllegalArgumentException("adId and Baziness userId must be positive");
        Map<String, Object> body = new LinkedHashMap<String, Object>();
        body.put("adId", adId);
        body.put("userId", userId);
        body.put("eventType", eventType);
        // Counting events is not idempotent: never replay an uncertain outcome (timeout, 500, 504).
        transport.request(new Transport.Call("trackAdEvent", "POST", "/content/ad-event", body, true, false).noJson());
    }

    public static final class Ad {
        public final long id;
        public final String title;
        public final String imageUrl;
        public final String link;

        private Ad(long id, String title, String imageUrl, String link) {
            this.id = id;
            this.title = title;
            this.imageUrl = imageUrl;
            this.link = link;
        }
    }
}
