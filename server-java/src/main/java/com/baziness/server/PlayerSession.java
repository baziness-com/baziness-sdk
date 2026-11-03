package com.baziness.server;

/** A player's Baziness session as your game server hands it to the player's device. */
public class PlayerSession {
    /** The Baziness user id of this player (one per game install, joined into a person by Baziness). */
    public final long userId;
    /** True once the player signed in with a phone number, false while anonymous. */
    public final boolean isLinkedToAccount;
    /** The player's token (long-lived): the device uses it for its own Baziness calls. */
    public final String accessToken;
    /** ISO time the token expires (years away; the device asks your server again after it). */
    public final String accessTokenExpiresAt;

    PlayerSession(long userId, boolean isLinkedToAccount, String accessToken, String accessTokenExpiresAt) {
        this.userId = userId;
        this.isLinkedToAccount = isLinkedToAccount;
        this.accessToken = accessToken;
        this.accessTokenExpiresAt = accessTokenExpiresAt;
    }
}
