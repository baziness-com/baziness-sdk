package com.baziness.server;

import java.util.ArrayList;
import java.util.Date;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;

/**
 * Player sessions as the game server sees them. Socket servers (SmartFox, Socket.IO) call
 * {@link #start} on login and {@link #end} on logout/disconnect; request/response servers call
 * {@link #touch} on every authenticated request and let the idle timeout end the session. Both send
 * {@code session_start}, a {@code session_heartbeat} every minute (value = seconds so far) and
 * {@code session_end} (value = length).
 */
public final class SessionTracker {
    private static final class Open {
        final String id;
        final long startedAt;
        final String appVersion;
        volatile long lastSeen;
        volatile long lastHeartbeat;
        volatile boolean activity;

        Open(String id, long now, String appVersion) {
            this.id = id;
            this.startedAt = now;
            this.lastSeen = now;
            this.lastHeartbeat = now;
            this.appVersion = appVersion;
        }
    }

    private final ServerAnalytics analytics;
    private final long heartbeatMs;
    private final long idleTimeoutMs;
    private final Map<Long, Open> open = new ConcurrentHashMap<Long, Open>();

    SessionTracker(ServerAnalytics analytics, long heartbeatMs, long idleTimeoutMs) {
        this.analytics = analytics;
        this.heartbeatMs = heartbeatMs;
        this.idleTimeoutMs = idleTimeoutMs;
    }

    /** Start a session (ending the player's open one first). {@code device} may be null. Returns the session id. */
    public String start(long userId, DeviceInfo device) {
        return start(userId, device, "connect", null);
    }

    public String start(long userId, DeviceInfo device, String reason, String sessionId) {
        end(userId, "replaced");
        long now = System.currentTimeMillis();
        Open session = new Open(sessionId != null ? sessionId : UUID.randomUUID().toString(), now,
                device != null ? device.appVersion : null);
        open.put(userId, session);
        emit(userId, session, "session_start", null, new ServerAnalytics.Event().prop("reason", reason), now);
        if (device != null) {
            emit(userId, session, "device_info", null, new ServerAnalytics.Event().props(device.toProps()), now);
        }
        return session.id;
    }

    /**
     * The player's open session, or a new one (connection-based servers: call it from the device's
     * session request, which repeats on every token renewal). Returns the session id.
     */
    public String ensure(long userId, DeviceInfo device) {
        Open session = open.get(userId);
        return session != null ? session.id : start(userId, device);
    }

    /** Record activity; starts an activity session when the player has none. Returns the session id. */
    public String touch(long userId, DeviceInfo device) {
        Open session = open.get(userId);
        if (session != null) {
            session.lastSeen = System.currentTimeMillis();
            return session.id;
        }
        String id = start(userId, device, "activity", null);
        Open started = open.get(userId);
        if (started != null) {
            started.activity = true;
        }
        return id;
    }

    /** End the player's open session, if any. */
    public void end(long userId, String reason) {
        Open session = open.remove(userId);
        if (session == null) {
            return;
        }
        long endedAt = session.activity ? session.lastSeen : System.currentTimeMillis();
        emit(userId, session, "session_end", seconds(endedAt - session.startedAt),
                new ServerAnalytics.Event().prop("reason", reason), endedAt);
    }

    public void end(long userId) {
        end(userId, "disconnect");
    }

    /** The player's open session id, or null. */
    public String current(long userId) {
        Open session = open.get(userId);
        return session == null ? null : session.id;
    }

    void endAll(String reason) {
        for (Long userId : new ArrayList<Long>(open.keySet())) {
            end(userId, reason);
        }
    }

    void tick() {
        long now = System.currentTimeMillis();
        for (Map.Entry<Long, Open> entry : open.entrySet()) {
            Open session = entry.getValue();
            if (session.activity && now - session.lastSeen > idleTimeoutMs) {
                end(entry.getKey(), "idle");
                continue;
            }
            if (now - session.lastHeartbeat >= heartbeatMs) {
                session.lastHeartbeat = now;
                long activeUntil = session.activity ? session.lastSeen : now;
                emit(entry.getKey(), session, "session_heartbeat", seconds(activeUntil - session.startedAt),
                        new ServerAnalytics.Event(), now);
            }
        }
    }

    private void emit(long userId, Open session, String key, Long value, ServerAnalytics.Event event, long at) {
        event.sessionId(session.id).time(new Date(at));
        if (value != null) {
            event.value(value);
        }
        if (session.appVersion != null) {
            event.appVersion(session.appVersion);
        }
        analytics.track(userId, key, event);
    }

    private static long seconds(long ms) {
        return Math.max(0, Math.round(ms / 1000.0));
    }
}
