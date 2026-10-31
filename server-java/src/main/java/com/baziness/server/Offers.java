package com.baziness.server;

import java.util.LinkedHashMap;
import java.util.Map;

/** Personal offers from the Baziness offer engine: which shop bundle to show a player now. */
public final class Offers {
    private final Transport transport;

    Offers(Transport transport) {
        this.transport = transport;
    }

    /**
     * The bundle to offer this player, or null when there is none now. {@code playerId} is
     * <b>your</b> player id, the one the offer engine was set up with for your game (not the
     * Baziness user id).
     */
    public Integer get(long playerId) {
        Map<String, Object> body = new LinkedHashMap<String, Object>();
        body.put("user_id", playerId);
        Map<String, Object> answer = Json.object(transport.request(
                new Transport.Call("getOffer", "POST", "/client/get-user-offer", body, true, true)));
        Object bundleId = answer.get("bundle_id");
        return bundleId instanceof Number ? Integer.valueOf(((Number) bundleId).intValue()) : null;
    }
}
