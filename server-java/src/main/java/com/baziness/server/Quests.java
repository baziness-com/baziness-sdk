package com.baziness.server;

import java.util.LinkedHashMap;
import java.util.Map;

/** Baziness missions: advance a quest for one player. */
public final class Quests {
    private final Transport transport;

    Quests(Transport transport) {
        this.transport = transport;
    }

    /**
     * Adds {@code count} to the player's progress on the quest of this event ({@code <game>/<event>}
     * for your own quests, {@code baziness/<event>} for platform-wide ones). <b>Not idempotent</b>:
     * call it once per real event.
     */
    public void progress(long userId, String questEventName, int count) {
        Map<String, Object> body = new LinkedHashMap<String, Object>();
        body.put("userId", userId);
        body.put("questEventName", questEventName);
        body.put("progressCount", count);
        transport.request(new Transport.Call("progressQuest", "POST", "/lottery/progress-quest", body, true, false).noJson());
    }
}
