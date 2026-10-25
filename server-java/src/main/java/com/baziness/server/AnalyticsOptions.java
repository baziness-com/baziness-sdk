package com.baziness.server;

/** Trusted-analytics behaviour. */
public final class AnalyticsOptions {
    /** Off: {@code track} does nothing. */
    public boolean enabled = true;
    /** Send a batch at least this often. */
    public long flushIntervalMs = 5000;
    /** Events per call; the platform accepts at most 100. */
    public int maxBatchSize = 100;
    /** Events kept in memory while the platform is unreachable; the oldest are dropped beyond it. */
    public int maxQueueSize = 20000;
    /** Your game server's version, sent with every event unless the event sets its own. */
    public String appVersion;
    /** Heartbeat interval of open sessions. */
    public long heartbeatMs = 60000;
    /** An activity session ({@link SessionTracker#touch}) ends after this long without activity. */
    public long idleTimeoutMs = 120000;
}
