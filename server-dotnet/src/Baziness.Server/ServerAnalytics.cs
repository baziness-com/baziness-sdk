using System.Globalization;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.RegularExpressions;

namespace Baziness.Server;

/// <summary>Which ad was shown, as your ad network names it.</summary>
/// <param name="Network">The ad network.</param>
/// <param name="Placement">Where it was shown.</param>
/// <param name="Format"><c>rewarded</c>, <c>interstitial</c>, <c>banner</c>, ...</param>
public sealed record AdPlacement(string Network, string Placement, string Format);

internal sealed class TrackOptions
{
    public double? Value { get; init; }
    public Dictionary<string, object?>? Props { get; init; }
    public string? SessionId { get; init; }

    /// <summary>A UUID; keep the same one when an event is re-sent so it counts once. Generated otherwise.</summary>
    public string? EventId { get; init; }

    public DateTimeOffset? Time { get; init; }
    public string? AppVersion { get; init; }
}

/// <summary>
/// Trusted analytics: events your game server reports about its own players, sent with the client token to
/// <c>analytics/server-events/batch</c>. Sessions, device data, sign-ins and purchases are accepted only through
/// here. Events are batched in memory, sent in the background and retried with backoff while the platform is busy or
/// unreachable; call <see cref="BazinessServer.CloseAsync"/> on shutdown to send the rest.
/// </summary>
public sealed partial class ServerAnalytics
{
    /// <summary>Same limits as the platform; an event over them is dropped here with a warning.</summary>
    public const string EventNamePattern = "^[a-z0-9_:.-]{1,128}$";

    private const int MaxProps = 32;
    private const int MaxPropKey = 64;
    private const int MaxPropValue = 512;
    private static readonly long[] BackoffStepsMs = [5000, 30000, 120000, 300000];

    private readonly Transport _transport;
    private readonly IBazinessLogger _logger;
    private readonly AnalyticsOptions _options;
    private readonly int _maxBatchSize;
    private readonly object _gate = new();
    private readonly List<WireServerEvent> _queue = [];

    private Timer? _timer;
    private Task? _flushing;
    private long _retryAt;
    private int _failures;
    private long _dropped;
    private bool _closed;

    internal ServerAnalytics(Transport transport, IBazinessLogger logger, AnalyticsOptions options)
    {
        _transport = transport;
        _logger = logger;
        _options = options;
        _maxBatchSize = Math.Clamp(options.MaxBatchSize, 1, 100);
        Sessions = new SessionTracker(this, options.HeartbeatMs, options.IdleTimeoutMs);
    }

    /// <summary>Player sessions: start and end on connect and disconnect, or touch on every request.</summary>
    public SessionTracker Sessions { get; }

    // ── The events Baziness analytics knows (admin panel: Growth → Events), for results your server
    // decides. Each goes with the player's open session, if any, and returns false when it was
    // dropped (analytics disabled).

    /// <summary>The player started a purchase (<c>iap_purchase_started</c>). Price in Toman; its completion is <see cref="Purchases.RecordAsync"/>.</summary>
    public bool PurchaseStarted(long userId, string sku, decimal price, PaymentGateway gateway) =>
        Game(userId, "iap_purchase_started", (double)price, new() { ["sku"] = sku, ["gateway"] = PaymentGateways.WireName(gateway) });

    /// <summary>The purchase was cancelled or failed (<c>iap_purchase_failed</c>); reason: <c>cancelled</c>, <c>error</c> or <c>pending</c>.</summary>
    public bool PurchaseFailed(long userId, string sku, PaymentGateway gateway, string reason) =>
        Game(userId, "iap_purchase_failed", null, new() { ["sku"] = sku, ["gateway"] = PaymentGateways.WireName(gateway), ["reason"] = reason });

    /// <summary>An ad was shown (<c>ad_impression</c>).</summary>
    public bool AdImpression(long userId, AdPlacement ad) =>
        Game(userId, "ad_impression", null, AdProps(ad));

    /// <summary>Paid ad revenue for an impression (<c>ad_revenue</c>), in Toman, e.g. from your ad network's server callback.</summary>
    public bool AdRevenue(long userId, AdPlacement ad, decimal revenue) =>
        Game(userId, "ad_revenue", (double)revenue, AdProps(ad));

    /// <summary>Onboarding started (<c>tutorial_begin</c>).</summary>
    public bool TutorialBegin(long userId, string? step = null) =>
        Game(userId, "tutorial_begin", null, new() { ["step"] = step });

    /// <summary>Onboarding finished (<c>tutorial_complete</c>).</summary>
    public bool TutorialComplete(long userId, string? step = null) =>
        Game(userId, "tutorial_complete", null, new() { ["step"] = step });

    /// <summary>A level, match or round started (<c>level_start</c>).</summary>
    public bool LevelStart(long userId, string level) =>
        Game(userId, "level_start", null, new() { ["level"] = level });

    /// <summary>A level, match or round won (<c>level_complete</c>).</summary>
    public bool LevelComplete(long userId, string level, double? score = null, double? durationSeconds = null) =>
        Game(userId, "level_complete", score, new() { ["level"] = level, ["duration_s"] = durationSeconds });

    /// <summary>A level, match or round lost (<c>level_fail</c>).</summary>
    public bool LevelFail(long userId, string level, double? score = null, double? durationSeconds = null, string? reason = null) =>
        Game(userId, "level_fail", score, new() { ["level"] = level, ["duration_s"] = durationSeconds, ["reason"] = reason });

    /// <summary>In-game currency or items gained (<c>resource_earn</c>).</summary>
    public bool ResourceEarn(long userId, string currency, double amount, string? item = null, string? source = null) =>
        Game(userId, "resource_earn", amount, new() { ["currency"] = currency, ["item"] = item, ["source"] = source });

    /// <summary>In-game currency or items spent (<c>resource_spend</c>).</summary>
    public bool ResourceSpend(long userId, string currency, double amount, string? item = null, string? sink = null) =>
        Game(userId, "resource_spend", amount, new() { ["currency"] = currency, ["item"] = item, ["sink"] = sink });

    private bool Game(long userId, string eventKey, double? value, Dictionary<string, object?> props) =>
        Track(userId, eventKey, new TrackOptions { Value = value, Props = props, SessionId = Sessions.Current(userId) });

    private static Dictionary<string, object?> AdProps(AdPlacement ad) =>
        new() { ["network"] = ad.Network, ["placement"] = ad.Placement, ["format"] = ad.Format };

    /// <summary>
    /// Queue one event about one of your players: the methods above, and what the SDK sends itself (sessions,
    /// sign-ins, purchases). Returns false when it was dropped (invalid or disabled).
    /// </summary>
    internal bool Track(long userId, string eventKey, TrackOptions? options = null)
    {
        options ??= new TrackOptions();
        if (!_options.Enabled)
            return false;

        var problem = Validate(userId, eventKey, options.Value);
        if (problem != null)
        {
            _logger.Warn($"[baziness] analytics event \"{eventKey}\" dropped: {problem}");
            return false;
        }

        var wire = new WireServerEvent
        {
            EventId = options.EventId ?? Guid.NewGuid().ToString(),
            EventKey = eventKey,
            UserId = userId,
            ClientTime = PlatformTime.ToIso(options.Time ?? DateTimeOffset.UtcNow),
            SessionId = string.IsNullOrEmpty(options.SessionId) ? null : options.SessionId,
            AppVersion = options.AppVersion ?? _options.AppVersion,
            Value = options.Value,
            Props = ToProps(options.Props)
        };

        bool flushNow;
        lock (_gate)
        {
            if (_closed)
                return false;

            _queue.Add(wire);
            if (_queue.Count > _options.MaxQueueSize)
            {
                _queue.RemoveAt(0);
                if (_dropped++ % 1000 == 0)
                    _logger.Warn($"[baziness] analytics queue full; dropped {_dropped} oldest event(s) so far");
            }

            _timer ??= new Timer(_ => _ = FlushAsync(), null, _options.FlushIntervalMs, _options.FlushIntervalMs);
            flushNow = _queue.Count >= _maxBatchSize;
        }

        if (flushNow)
            _ = FlushAsync();
        return true;
    }

    /// <summary>Send everything queued now (one batch after another). Never throws.</summary>
    public Task FlushAsync()
    {
        lock (_gate)
            return _flushing ??= Task.Run(DrainAsync);
    }

    /// <summary>Events waiting to be sent.</summary>
    public int Pending
    {
        get
        {
            lock (_gate)
                return _queue.Count;
        }
    }

    /// <summary>End open sessions, stop the timer and send what is left, waiting at most this long.</summary>
    internal async Task CloseAsync(int timeoutMs)
    {
        Sessions.EndAll("shutdown");
        lock (_gate)
        {
            _closed = true;
            _timer?.Dispose();
            _timer = null;
            _retryAt = 0;
        }

        // Twice: a flush already on its way out may not have seen what was just queued.
        var deadline = Task.Delay(timeoutMs);
        for (var attempt = 0; attempt < 2 && Pending > 0; attempt++)
        {
            if (await Task.WhenAny(FlushAsync(), deadline).ConfigureAwait(false) == deadline)
                return;
        }
    }

    private async Task DrainAsync()
    {
        try
        {
            while (true)
            {
                List<WireServerEvent> batch;
                lock (_gate)
                {
                    if (_queue.Count == 0 || Transport.Now < _retryAt)
                        return;
                    batch = _queue.Take(_maxBatchSize).ToList();
                }

                var finished = await SendAsync(batch).ConfigureAwait(false);
                lock (_gate)
                {
                    if (!finished)
                    {
                        _retryAt = Transport.Now + BackoffStepsMs[Math.Min(_failures, BackoffStepsMs.Length - 1)];
                        _failures++;
                        return;
                    }

                    _failures = 0;
                    _retryAt = 0;

                    // Only now: events tracked while the batch was in flight stay queued behind it.
                    var sent = batch.ToHashSet();
                    _queue.RemoveAll(sent.Contains);
                }
            }
        }
        finally
        {
            lock (_gate)
                _flushing = null;
        }
    }

    /// <summary>True when the batch is done with (sent, or wrong and dropped); false to keep it for later.</summary>
    private async Task<bool> SendAsync(List<WireServerEvent> batch)
    {
        try
        {
            var answer = await _transport.RequestAsync<JsonElement>(new RequestSpec("serverEvents", HttpMethod.Post, "/analytics/server-events/batch")
            {
                Body = new { events = batch },
                // Every event carries its id, so a batch sent twice counts once.
                Idempotent = true
            }).ConfigureAwait(false);

            if (answer.ValueKind == JsonValueKind.Object &&
                answer.TryGetProperty("rejected", out var rejected) &&
                rejected.ValueKind == JsonValueKind.Number && rejected.GetInt32() > 0)
            {
                var errors = answer.TryGetProperty("errors", out var list) ? list.GetRawText() : "[]";
                _logger.Warn($"[baziness] analytics: {rejected.GetInt32()} event(s) rejected: {errors}");
            }

            return true;
        }
        catch (BazinessException e) when (e.Status is >= 400 and < 500 and not 429 and not 401)
        {
            // The batch itself is wrong; sending it again cannot help.
            _logger.Error($"[baziness] analytics: batch of {batch.Count} dropped: {e.Message}");
            return true;
        }
        catch (Exception e)
        {
            _logger.Warn($"[baziness] analytics: {e.Message}; {Pending} event(s) kept for later");
            return false;
        }
    }

    /// <summary>A UUID derived from <paramref name="key"/> (name-based, SHA-1), for events that must count once however often they are sent.</summary>
    public static string StableEventId(string key)
    {
        var bytes = SHA1.HashData(Encoding.UTF8.GetBytes($"baziness:{key}"))[..16];
        bytes[6] = (byte)((bytes[6] & 0x0f) | 0x50);
        bytes[8] = (byte)((bytes[8] & 0x3f) | 0x80);
        var hex = Convert.ToHexString(bytes).ToLowerInvariant();
        return $"{hex[..8]}-{hex[8..12]}-{hex[12..16]}-{hex[16..20]}-{hex[20..]}";
    }

    /// <summary>Device fields as <c>device_info</c> props (snake_case strings).</summary>
    internal static Dictionary<string, object?> DeviceProps(DeviceInfo device) => new()
    {
        ["device_id"] = device.DeviceId,
        ["platform"] = device.Platform,
        ["store"] = device.Store,
        ["model"] = device.Model,
        ["manufacturer"] = device.Manufacturer,
        ["device_type"] = device.DeviceType,
        ["os"] = device.Os,
        ["os_version"] = device.OsVersion,
        ["app_version"] = device.AppVersion,
        ["sdk"] = device.Sdk,
        ["sdk_version"] = device.SdkVersion,
        ["locale"] = device.Locale,
        ["timezone"] = device.Timezone,
        ["screen"] = device is { ScreenWidth: > 0, ScreenHeight: > 0 } ? $"{device.ScreenWidth}x{device.ScreenHeight}" : null,
        ["dpi"] = device.Dpi,
        ["memory_mb"] = device.MemoryMb,
        ["browser"] = device.Browser,
        ["installer"] = device.Installer,
        ["network"] = device.Network
    };

    private static string? Validate(long userId, string eventKey, double? value)
    {
        if (userId <= 0)
            return "userId must be a Baziness user id";
        if (!EventName().IsMatch(eventKey))
            return "name must be 1-128 of a-z 0-9 _ : . -";
        if (value is { } number && !double.IsFinite(number))
            return "value must be a finite number";
        return null;
    }

    private static Dictionary<string, string>? ToProps(Dictionary<string, object?>? props)
    {
        if (props == null)
            return null;

        var result = new Dictionary<string, string>();
        foreach (var (key, raw) in props)
        {
            var text = raw switch
            {
                null => null,
                bool flag => flag ? "true" : "false",
                _ => Convert.ToString(raw, CultureInfo.InvariantCulture)
            };
            if (string.IsNullOrEmpty(text))
                continue;
            if (result.Count >= MaxProps)
                break;

            result[key.Length > MaxPropKey ? key[..MaxPropKey] : key] =
                text.Length > MaxPropValue ? text[..MaxPropValue] : text;
        }

        return result.Count > 0 ? result : null;
    }

    [GeneratedRegex(EventNamePattern)]
    private static partial Regex EventName();

    private sealed class WireServerEvent
    {
        public required string EventId { get; init; }
        public required string EventKey { get; init; }
        public required long UserId { get; init; }
        public required string ClientTime { get; init; }
        public string? SessionId { get; init; }
        public string? AppVersion { get; init; }
        public double? Value { get; init; }
        public Dictionary<string, string>? Props { get; init; }
    }
}
