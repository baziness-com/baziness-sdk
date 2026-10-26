package com.baziness.server;

/**
 * Where an integration from 1.0 kept each player's refresh token, keyed by Baziness user id. Since
 * 1.1 your server keeps no token (its client secret gets a new access token whenever needed); if
 * you still pass a store, {@code players().logout} revokes and removes what is left in it, and
 * nothing else uses it. {@code set(userId, null)} removes a token. Must be thread-safe.
 */
public interface RefreshTokenStore {
    String get(long userId);

    void set(long userId, String refreshToken);
}
