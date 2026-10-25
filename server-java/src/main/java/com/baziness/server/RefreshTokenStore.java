package com.baziness.server;

/**
 * Where the game keeps each player's refresh token, keyed by Baziness user id. The token is a
 * password: keep it on your server only (a {@code baziness_sessions} table or Redis), never log it,
 * never send it to a device. {@code set(userId, null)} removes it. Must be safe to call from several
 * threads.
 */
public interface RefreshTokenStore {
    String get(long userId);

    void set(long userId, String refreshToken);
}
