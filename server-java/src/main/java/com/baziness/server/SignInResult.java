package com.baziness.server;

/** What {@link Players#signIn} found. */
public final class SignInResult extends PlayerSession {
    /** How the session was found. */
    public enum Method {
        /** A new Baziness user was created for this device. */
        CREATED("created"),
        /** The player arrived with a link code (from the Baziness app or another game): same person. */
        LINK_CODE("link_code"),
        /** A known player's session was renewed with its refresh token. */
        REFRESH("refresh"),
        /** A known player had no live session; a new one was started. */
        NEW_SESSION("new_session");

        public final String wireName;

        Method(String wireName) {
            this.wireName = wireName;
        }
    }

    public final Method method;
    /** A link code was sent but had expired or was already used; the player continued without it. */
    public final boolean linkCodeRejected;

    SignInResult(PlayerSession session, Method method, boolean linkCodeRejected) {
        super(session.userId, session.isLinkedToAccount, session.accessToken, session.accessTokenExpiresAt);
        this.method = method;
        this.linkCodeRejected = linkCodeRejected;
    }
}
