package com.baziness.server;

/** Network behaviour. The defaults suit a call that sits on a player-facing request. */
public final class HttpOptions {
    /** Timeout of one attempt (connect and read). */
    public int timeoutMs = 8000;
    /** Ceiling for one logical call: every attempt, backoff and the 401 re-authentication. */
    public long deadlineMs = 15000;
    /** Attempts for failures worth retrying. */
    public int maxAttempts = 3;
    /** First backoff; it doubles per attempt, with jitter. */
    public long retryBaseMs = 300;
    /** Requests in flight at once; 0 = no limit. */
    public int maxConcurrent = 32;
    /** Consecutive "platform unavailable" failures of one operation that open its breaker; 0 = off. */
    public int breakerThreshold = 8;
    /** How long an open breaker fails calls at once before letting one probe through. */
    public long breakerResetMs = 15000;
}
