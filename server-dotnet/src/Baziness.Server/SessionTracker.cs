namespace Baziness.Server;

public sealed class SessionStartOptions
{
    /// <summary>Your own session id; a UUID is generated otherwise.</summary>
    public string? SessionId { get; init; }

    /// <summary>Why it started: <c>connect</c>, <c>cold_start</c>, <c>resume</c>, ... Default <c>connect</c>.</summary>
    public string? Reason { get; init; }

    /// <summary>From the device SDK; sent once per session as <c>device_info</c>.</summary>
    public DeviceInfo? Device { get; init; }

    public string? AppVersion { get; init; }
}

/// <summary>
/// Player sessions as the game server sees them. Socket servers call <see cref="Start"/> on connect and
/// <see cref="End"/> on disconnect; request/response servers call <see cref="Touch"/> on every authenticated request
/// and let the idle timeout end the session. Both send <c>session_start</c>, a <c>session_heartbeat</c> every minute
/// (value = seconds so far) and <c>session_end</c> (value = length).
/// </summary>
public sealed class SessionTracker
{
    private readonly ServerAnalytics _analytics;
    private readonly int _heartbeatMs;
    private readonly int _idleTimeoutMs;
    private readonly object _gate = new();
    private readonly Dictionary<long, OpenSession> _open = new();
    private Timer? _timer;

    internal SessionTracker(ServerAnalytics analytics, int heartbeatMs, int idleTimeoutMs)
    {
        _analytics = analytics;
        _heartbeatMs = heartbeatMs;
        _idleTimeoutMs = idleTimeoutMs;
    }

    /// <summary>Start a session (ending the player's open one first). Returns the session id.</summary>
    public string Start(long userId, SessionStartOptions? options = null)
    {
        lock (_gate)
            return StartSession(userId, options, activity: false);
    }

    /// <summary>
    /// The player's open session, or a new one (connection-based servers: call it from the device's session request,
    /// which can repeat). Returns the session id.
    /// </summary>
    public string Ensure(long userId, SessionStartOptions? options = null)
    {
        lock (_gate)
            return _open.TryGetValue(userId, out var session) ? session.Id : StartSession(userId, options, activity: false);
    }

    /// <summary>Record activity; starts an activity session when the player has none. Returns the session id.</summary>
    public string Touch(long userId, SessionStartOptions? options = null)
    {
        lock (_gate)
        {
            if (_open.TryGetValue(userId, out var session))
            {
                session.LastSeen = DateTimeOffset.UtcNow;
                return session.Id;
            }

            return StartSession(userId, new SessionStartOptions
            {
                SessionId = options?.SessionId,
                Reason = "activity",
                Device = options?.Device,
                AppVersion = options?.AppVersion
            }, activity: true);
        }
    }

    /// <summary>End the player's open session, if any.</summary>
    public void End(long userId, string reason = "disconnect")
    {
        lock (_gate)
        {
            if (!_open.Remove(userId, out var session))
                return;

            var endedAt = session.Activity ? session.LastSeen : DateTimeOffset.UtcNow;
            Emit(userId, session, "session_end", Seconds(endedAt - session.StartedAt),
                new Dictionary<string, object?> { ["reason"] = reason }, endedAt);
        }
    }

    /// <summary>The player's open session id, if any.</summary>
    public string? Current(long userId)
    {
        lock (_gate)
            return _open.TryGetValue(userId, out var session) ? session.Id : null;
    }

    public void EndAll(string reason)
    {
        lock (_gate)
        {
            foreach (var userId in _open.Keys.ToArray())
                End(userId, reason);

            _timer?.Dispose();
            _timer = null;
        }
    }

    private string StartSession(long userId, SessionStartOptions? options, bool activity)
    {
        End(userId, "replaced");

        var now = DateTimeOffset.UtcNow;
        var session = new OpenSession
        {
            Id = options?.SessionId ?? Guid.NewGuid().ToString(),
            StartedAt = now,
            LastSeen = now,
            LastHeartbeat = now,
            AppVersion = options?.AppVersion ?? options?.Device?.AppVersion,
            Activity = activity
        };
        _open[userId] = session;

        Emit(userId, session, "session_start", null, new Dictionary<string, object?> { ["reason"] = options?.Reason ?? "connect" });
        if (options?.Device != null)
            Emit(userId, session, "device_info", null, ServerAnalytics.DeviceProps(options.Device));

        if (_timer == null)
        {
            var period = Math.Min(_heartbeatMs, 15000);
            _timer = new Timer(_ => TickQuietly(), null, period, period);
        }

        return session.Id;
    }

    /// <summary>An exception out of a timer ends the process; a logger of the game's must not be able to do that.</summary>
    private void TickQuietly()
    {
        try
        {
            Tick();
        }
        catch (Exception)
        {
            // The next tick tries again.
        }
    }

    private void Tick()
    {
        lock (_gate)
        {
            var now = DateTimeOffset.UtcNow;
            foreach (var (userId, session) in _open.ToArray())
            {
                if (session.Activity && (now - session.LastSeen).TotalMilliseconds > _idleTimeoutMs)
                {
                    End(userId, "idle");
                    continue;
                }

                if ((now - session.LastHeartbeat).TotalMilliseconds >= _heartbeatMs)
                {
                    session.LastHeartbeat = now;
                    var activeUntil = session.Activity ? session.LastSeen : now;
                    Emit(userId, session, "session_heartbeat", Seconds(activeUntil - session.StartedAt));
                }
            }

            if (_open.Count == 0)
            {
                _timer?.Dispose();
                _timer = null;
            }
        }
    }

    private void Emit(long userId, OpenSession session, string eventKey, double? value = null,
        Dictionary<string, object?>? props = null, DateTimeOffset? time = null)
    {
        _analytics.Track(userId, eventKey, new TrackOptions
        {
            SessionId = session.Id,
            Value = value,
            Props = props,
            Time = time,
            AppVersion = session.AppVersion
        });
    }

    private static double Seconds(TimeSpan span) => Math.Max(0, Math.Round(span.TotalSeconds));

    private sealed class OpenSession
    {
        public required string Id { get; init; }
        public required DateTimeOffset StartedAt { get; init; }
        public required DateTimeOffset LastSeen { get; set; }
        public required DateTimeOffset LastHeartbeat { get; set; }
        public string? AppVersion { get; init; }

        /// <summary>True: ended by the idle timeout. False: ended by <see cref="End"/>.</summary>
        public required bool Activity { get; init; }
    }
}
