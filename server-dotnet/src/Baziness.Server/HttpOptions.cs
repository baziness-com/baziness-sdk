namespace Baziness.Server;

/// <summary>Network behaviour. The defaults suit a call that sits on a player-facing request.</summary>
public sealed class HttpOptions
{
    /// <summary>Timeout of one attempt, headers and body included.</summary>
    public int TimeoutMs { get; init; } = 8000;

    /// <summary>
    /// Ceiling for one logical call: every attempt, backoff, the wait for a free slot and the 401
    /// re-authentication.
    /// </summary>
    public int DeadlineMs { get; init; } = 15000;

    /// <summary>Attempts for failures worth retrying.</summary>
    public int MaxAttempts { get; init; } = 3;

    /// <summary>First backoff; it doubles per attempt, with jitter.</summary>
    public int RetryBaseMs { get; init; } = 300;

    /// <summary>Requests in flight at once; a slow platform then fails fast instead of piling up. 0 = no limit.</summary>
    public int MaxConcurrent { get; init; } = 32;

    /// <summary>Consecutive "platform unavailable" failures of one operation that open its breaker. 0 = off.</summary>
    public int BreakerThreshold { get; init; } = 8;

    /// <summary>How long an open breaker fails calls at once before letting one probe through.</summary>
    public int BreakerResetMs { get; init; } = 15000;
}
