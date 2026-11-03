namespace Baziness.Server;

/// <summary>Trusted-analytics behaviour.</summary>
public sealed class AnalyticsOptions
{
    /// <summary>Off: events are dropped (for tests or a game that opts out temporarily).</summary>
    public bool Enabled { get; init; } = true;

    /// <summary>Send a batch at least this often.</summary>
    public int FlushIntervalMs { get; init; } = 5000;

    /// <summary>Events per call; the platform accepts at most 100.</summary>
    public int MaxBatchSize { get; init; } = 100;

    /// <summary>Events kept in memory while the platform is unreachable; the oldest are dropped beyond it.</summary>
    public int MaxQueueSize { get; init; } = 20000;

    /// <summary>Your game server's version, sent with every event unless the event sets its own.</summary>
    public string? AppVersion { get; init; }

    /// <summary>Heartbeat interval of open sessions.</summary>
    public int HeartbeatMs { get; init; } = 60000;

    /// <summary>An activity session (<see cref="SessionTracker.Touch"/>) ends after this long without activity.</summary>
    public int IdleTimeoutMs { get; init; } = 120000;
}
