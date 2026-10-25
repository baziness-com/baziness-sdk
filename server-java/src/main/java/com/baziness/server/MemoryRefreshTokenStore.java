package com.baziness.server;

import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;

/** In-memory {@link RefreshTokenStore} for tests and local development. Lost on restart. */
public final class MemoryRefreshTokenStore implements RefreshTokenStore {
    private final Map<Long, String> tokens = new ConcurrentHashMap<Long, String>();

    @Override
    public String get(long userId) {
        return tokens.get(userId);
    }

    @Override
    public void set(long userId, String refreshToken) {
        if (refreshToken == null || refreshToken.isEmpty()) {
            tokens.remove(userId);
        } else {
            tokens.put(userId, refreshToken);
        }
    }
}
