package com.baziness.server;

import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.text.SimpleDateFormat;
import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.Date;
import java.util.Deque;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.TimeZone;
import java.util.UUID;
import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.ThreadFactory;
import java.util.concurrent.TimeUnit;
import java.util.regex.Pattern;

/**
 * Trusted analytics: events your game server reports about its own players, sent with the client
 * token to {@code analytics/server-events/batch}. Sessions, device data, sign-ins and purchases are
 * accepted only through here. Events are batched in memory and sent by one background thread, with
 * backoff while the platform is busy or unreachable; call {@link BazinessServer#close} on shutdown.
 */
public final class ServerAnalytics {
    /** Same limits as the platform; an event over them is dropped here with a warning. */
    public static final Pattern EVENT_NAME = Pattern.compile("^[a-z0-9_:.\\-]{1,128}$");
    private static final int MAX_PROPS = 32;
    private static final int MAX_PROP_KEY = 64;
    private static final int MAX_PROP_VALUE = 512;
    private static final long[] BACKOFF_MS = {5000, 30000, 120000, 300000};

    /** One event's optional parts. */
    public static final class Event {
        Double value;
        Map<String, Object> props;
        String sessionId;
        String eventId;
        Date time;
        String appVersion;

        public Event value(double value) {
            this.value = value;
            return this;
        }

        /** Values become strings; null values are left out. */
        public Event props(Map<String, ?> props) {
            this.props = props == null ? null : new LinkedHashMap<String, Object>(props);
            return this;
        }

        public Event prop(String key, Object value) {
            if (props == null) {
                props = new LinkedHashMap<String, Object>();
            }
            props.put(key, value);
            return this;
        }

        public Event sessionId(String sessionId) {
            this.sessionId = sessionId;
            return this;
        }

        /** A UUID; keep the same one when you re-send an event so it counts once (see {@link #stableEventId}). */
        public Event eventId(String eventId) {
            this.eventId = eventId;
            return this;
        }

        public Event time(Date time) {
            this.time = time;
            return this;
        }

        public Event appVersion(String appVersion) {
            this.appVersion = appVersion;
            return this;
        }
    }

    private final Transport transport;
    private final BazinessLogger logger;
    private final AnalyticsOptions options;
    private final Deque<Map<String, Object>> queue = new ArrayDeque<Map<String, Object>>();
    private final ScheduledExecutorService worker;
    private final SessionTracker sessions;
    private final Object flushLock = new Object();
    private volatile boolean closed;
    private long retryAt;
    private int failures;
    private long dropped;

    ServerAnalytics(Transport transport, BazinessLogger logger, AnalyticsOptions options) {
        this.transport = transport;
        this.logger = logger;
        this.options = options;
        this.worker = Executors.newSingleThreadScheduledExecutor(new ThreadFactory() {
            @Override
            public Thread newThread(Runnable runnable) {
                Thread thread = new Thread(runnable, "baziness-analytics");
                thread.setDaemon(true);
                return thread;
            }
        });
        this.sessions = new SessionTracker(this, options.heartbeatMs, options.idleTimeoutMs);
        if (options.enabled) {
            worker.scheduleWithFixedDelay(new Runnable() {
                @Override
                public void run() {
                    flushQuietly(false);
                    sessions.tick();
                }
            }, Math.min(options.flushIntervalMs, 15000), Math.min(options.flushIntervalMs, 15000), TimeUnit.MILLISECONDS);
        }
    }

    /** Player sessions: start/end on connect/disconnect, or touch on every request. */
    public SessionTracker sessions() {
        return sessions;
    }

    public boolean track(long userId, String eventKey) {
        return track(userId, eventKey, new Event());
    }

    /** Queue one event about one of your players. Returns false when it was dropped (invalid or disabled). */
    public boolean track(long userId, String eventKey, Event event) {
        if (!options.enabled || closed) {
            return false;
        }
        String problem = validate(userId, eventKey, event.value);
        if (problem != null) {
            logger.warn("[baziness] analytics event \"" + eventKey + "\" dropped: " + problem);
            return false;
        }
        Map<String, Object> wire = new LinkedHashMap<String, Object>();
        wire.put("eventId", event.eventId != null ? event.eventId : UUID.randomUUID().toString());
        wire.put("eventKey", eventKey);
        wire.put("userId", userId);
        wire.put("clientTime", iso(event.time != null ? event.time : new Date()));
        wire.put("sessionId", event.sessionId);
        wire.put("appVersion", event.appVersion != null ? event.appVersion : options.appVersion);
        wire.put("value", event.value);
        wire.put("props", toProps(event.props));
        int size;
        synchronized (queue) {
            queue.addLast(wire);
            if (queue.size() > options.maxQueueSize) {
                queue.removeFirst();
                if (dropped++ % 1000 == 0) {
                    logger.warn("[baziness] analytics queue full; dropped " + dropped + " oldest event(s) so far");
                }
            }
            size = queue.size();
        }
        if (size >= options.maxBatchSize) {
            worker.execute(new Runnable() {
                @Override
                public void run() {
                    flushQuietly(false);
                }
            });
        }
        return true;
    }

    /** Send everything queued now, on the calling thread. Never throws. */
    public void flush() {
        flushQuietly(false);
    }

    /** Events waiting to be sent. */
    public int pending() {
        synchronized (queue) {
            return queue.size();
        }
    }

    void close(long timeoutMs) {
        sessions.endAll("shutdown");
        closed = true;
        worker.shutdown();
        try {
            worker.awaitTermination(timeoutMs, TimeUnit.MILLISECONDS);
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
        }
        flushQuietly(true);
    }

    private void flushQuietly(boolean ignoreBackoff) {
        synchronized (flushLock) {
            while (true) {
                if (!ignoreBackoff && System.currentTimeMillis() < retryAt) {
                    return;
                }
                List<Map<String, Object>> batch = new ArrayList<Map<String, Object>>();
                synchronized (queue) {
                    for (Map<String, Object> event : queue) {
                        if (batch.size() >= options.maxBatchSize) {
                            break;
                        }
                        batch.add(event);
                    }
                }
                if (batch.isEmpty()) {
                    return;
                }
                if (!send(batch)) {
                    retryAt = System.currentTimeMillis() + BACKOFF_MS[Math.min(failures, BACKOFF_MS.length - 1)];
                    failures++;
                    return;
                }
                failures = 0;
                retryAt = 0;
                synchronized (queue) {
                    for (int i = 0; i < batch.size() && !queue.isEmpty(); i++) {
                        queue.removeFirst();
                    }
                }
            }
        }
    }

    /** True when the batch is done with (sent, or wrong and dropped); false to keep it for later. */
    private boolean send(List<Map<String, Object>> batch) {
        Map<String, Object> body = new LinkedHashMap<String, Object>();
        body.put("events", batch);
        try {
            // Every event carries its id, so a batch sent twice counts once.
            Map<String, Object> answer = Json.object(transport.request(new Transport.Call(
                    "serverEvents", "POST", "/analytics/server-events/batch", body, true, true)));
            long rejected = Json.number(answer, "rejected");
            if (rejected > 0) {
                logger.warn("[baziness] analytics: " + rejected + " event(s) rejected: " + answer.get("errors"));
            }
            return true;
        } catch (BazinessException e) {
            if (e.status() >= 400 && e.status() < 500 && e.status() != 429 && e.status() != 401) {
                logger.error("[baziness] analytics: batch of " + batch.size() + " dropped: " + e.getMessage());
                return true;
            }
            logger.warn("[baziness] analytics: " + e.getMessage() + "; " + pending() + " event(s) kept for later");
            return false;
        }
    }

    /** A UUID derived from {@code key} (SHA-1 name-based), identical to the Node SDK's {@code stableEventId}. */
    public static String stableEventId(String key) {
        try {
            byte[] digest = MessageDigest.getInstance("SHA-1").digest(("baziness:" + key).getBytes(StandardCharsets.UTF_8));
            digest[6] = (byte) ((digest[6] & 0x0f) | 0x50);
            digest[8] = (byte) ((digest[8] & 0x3f) | 0x80);
            long most = 0;
            long least = 0;
            for (int i = 0; i < 8; i++) {
                most = (most << 8) | (digest[i] & 0xff);
            }
            for (int i = 8; i < 16; i++) {
                least = (least << 8) | (digest[i] & 0xff);
            }
            return new UUID(most, least).toString();
        } catch (NoSuchAlgorithmException e) {
            throw new IllegalStateException(e);
        }
    }

    private static String validate(long userId, String eventKey, Double value) {
        if (userId <= 0) {
            return "userId must be a Baziness user id";
        }
        if (eventKey == null || !EVENT_NAME.matcher(eventKey).matches()) {
            return "name must be 1-128 of a-z 0-9 _ : . -";
        }
        if (value != null && (value.isNaN() || value.isInfinite())) {
            return "value must be a finite number";
        }
        return null;
    }

    private static Map<String, Object> toProps(Map<String, Object> props) {
        if (props == null) {
            return null;
        }
        Map<String, Object> result = new LinkedHashMap<String, Object>();
        for (Map.Entry<String, Object> entry : props.entrySet()) {
            Object raw = entry.getValue();
            if (raw == null || raw.toString().isEmpty()) {
                continue;
            }
            if (result.size() >= MAX_PROPS) {
                break;
            }
            String key = entry.getKey().length() > MAX_PROP_KEY ? entry.getKey().substring(0, MAX_PROP_KEY) : entry.getKey();
            String text = raw.toString();
            result.put(key, text.length() > MAX_PROP_VALUE ? text.substring(0, MAX_PROP_VALUE) : text);
        }
        return result.isEmpty() ? null : result;
    }

    static String iso(Date time) {
        SimpleDateFormat format = new SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss.SSS'Z'");
        format.setTimeZone(TimeZone.getTimeZone("UTC"));
        return format.format(time);
    }
}
