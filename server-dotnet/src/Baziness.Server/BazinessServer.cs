using System.Collections;
using System.Globalization;

namespace Baziness.Server;

public sealed class BazinessServerOptions
{
    /// <summary><c>Staging</c> while you integrate and test; <c>Production</c> after the platform team's review.</summary>
    public required BazinessEnvironment Environment { get; init; }

    /// <summary>Client id of this environment.</summary>
    public required long ClientId { get; init; }

    /// <summary>Client secret of this environment. <b>Server only</b>: never in a client build, a log or git.</summary>
    public required string ClientSecret { get; init; }

    /// <summary>Override the API root (a local platform stack, for example).</summary>
    public string? ApiBaseUrl { get; init; }

    /// <summary>Override the Baziness Pay root (a local Pay, or the Pay address your game already uses).</summary>
    public string? PayBaseUrl { get; init; }

    public HttpOptions Http { get; init; } = new();
    public AnalyticsOptions Analytics { get; init; } = new();

    /// <summary>Default: silent. The SDK never logs secrets or tokens.</summary>
    public IBazinessLogger? Logger { get; init; }

    /// <summary>Default: the SDK's own. Yours is never disposed by the SDK; each attempt has its own timeout (<see cref="HttpOptions.TimeoutMs"/>).</summary>
    public HttpClient? HttpClient { get; init; }
}

/// <summary>Settings that are safe to send to the device SDK.</summary>
public sealed record PublicConfig(BazinessEnvironment Environment, string ApiUrl, string PagesUrl, string PayUrl);

/// <summary>
/// The Baziness SDK for game servers. One instance per process; it is safe to share.
/// <code>
/// var baziness = BazinessServer.FromEnv();
/// var session = await baziness.Players.SignInAsync(
///     new SignInRequest(deviceId, BazinessPlatform.Web, BazinessStore.Direct) { UserId = userId, LinkCode = linkCode });
/// </code>
/// </summary>
public sealed class BazinessServer : IAsyncDisposable
{
    public const string SdkVersion = "2.4.0";

    private const int DefaultCloseTimeoutMs = 5000;

    private readonly string _apiBase;
    private readonly string _payBase;
    private readonly Transport _payTransport;
    private readonly HttpClient? _ownedHttpClient;
    private readonly object _closeGate = new();
    private Task? _closing;

    public BazinessServer(BazinessServerOptions options)
    {
        ArgumentNullException.ThrowIfNull(options);
        if (options.ClientId <= 0)
            throw new ArgumentException("BazinessServer: clientId must be the positive client id of this environment", nameof(options));
        if (string.IsNullOrWhiteSpace(options.ClientSecret))
            throw new ArgumentException("BazinessServer: clientSecret is required", nameof(options));

        var logger = options.Logger ?? BazinessLogger.Silent;
        var urls = BazinessEnvironments.Urls(options.Environment);
        Environment = options.Environment;

        _apiBase = (string.IsNullOrWhiteSpace(options.ApiBaseUrl) ? urls.Api : options.ApiBaseUrl.Trim()).TrimEnd('/');
        if (options.Environment == BazinessEnvironment.Production && !string.IsNullOrWhiteSpace(options.ApiBaseUrl))
            logger.Warn($"[baziness] production with an API override: {_apiBase}");

        _ownedHttpClient = options.HttpClient == null
            ? new HttpClient(new SocketsHttpHandler { PooledConnectionLifetime = TimeSpan.FromMinutes(2) })
            {
                // Each attempt has its own timeout (HttpOptions.TimeoutMs).
                Timeout = Timeout.InfiniteTimeSpan
            }
            : null;
        var http = options.HttpClient ?? _ownedHttpClient!;

        var transport = new Transport(_apiBase, options.Http, http, logger);
        var clientAuth = new ClientAuth(transport, options.ClientId, options.ClientSecret);
        transport.UseClientToken(clientAuth.GetAsync);

        Analytics = new ServerAnalytics(transport, logger, options.Analytics);
        Players = new Players(transport, Analytics, logger);
        Coins = new Coins(transport);
        Purchases = new Purchases(transport, Analytics);
        Quests = new Quests(transport);
        Offers = new Offers(transport);
        Ads = new Ads(transport);
        _payBase = (string.IsNullOrWhiteSpace(options.PayBaseUrl) ? urls.Pay : options.PayBaseUrl.Trim()).TrimEnd('/');
        _payTransport = new Transport(_payBase, options.Http, http, logger);
    }

    public BazinessEnvironment Environment { get; }
    public Players Players { get; }
    public Coins Coins { get; }
    public Purchases Purchases { get; }
    public ServerAnalytics Analytics { get; }
    public Quests Quests { get; }
    public Offers Offers { get; }
    public Ads Ads { get; }

    /// <summary>
    /// Baziness Pay for one of your apps (<paramref name="packageName"/>: the app as registered in Pay, Pay's
    /// <c>pname</c>): check and consume the payments of its web checkout.
    /// </summary>
    public Pay Pay(string packageName) => new(_payTransport, packageName);

    /// <summary>
    /// Reads <c>BAZINESS_ENVIRONMENT</c> (<c>staging</c> | <c>production</c>), <c>BAZINESS_CLIENT_ID</c>,
    /// <c>BAZINESS_CLIENT_SECRET</c> and optionally <c>BAZINESS_API_BASE_URL</c> and <c>BAZINESS_PAY_BASE_URL</c>,
    /// from <paramref name="env"/> or else the process's environment.
    /// </summary>
    public static BazinessServer FromEnv(
        IReadOnlyDictionary<string, string?>? env = null,
        HttpOptions? http = null,
        AnalyticsOptions? analytics = null,
        IBazinessLogger? logger = null,
        HttpClient? httpClient = null)
    {
        env ??= ProcessEnvironment();
        var clientId = env.GetValueOrDefault("BAZINESS_CLIENT_ID")?.Trim();
        if (!long.TryParse(clientId, NumberStyles.Integer, CultureInfo.InvariantCulture, out var id))
            throw new ArgumentException("BAZINESS_CLIENT_ID must be the numeric client id", nameof(env));

        return new BazinessServer(new BazinessServerOptions
        {
            Environment = BazinessEnvironments.Parse(env.GetValueOrDefault("BAZINESS_ENVIRONMENT") ?? "staging"),
            ClientId = id,
            ClientSecret = env.GetValueOrDefault("BAZINESS_CLIENT_SECRET") ?? "",
            ApiBaseUrl = env.GetValueOrDefault("BAZINESS_API_BASE_URL"),
            PayBaseUrl = env.GetValueOrDefault("BAZINESS_PAY_BASE_URL"),
            Http = http ?? new HttpOptions(),
            Analytics = analytics ?? new AnalyticsOptions(),
            Logger = logger,
            HttpClient = httpClient
        });
    }

    /// <summary>What the device SDK needs to know about this environment; nothing secret.</summary>
    public PublicConfig PublicConfig() =>
        new(Environment, _apiBase, BazinessEnvironments.Urls(Environment).Pages, _payBase);

    /// <summary>Ends open sessions and sends the remaining analytics. Call it on shutdown; later calls do nothing more.</summary>
    public Task CloseAsync(int timeoutMs = DefaultCloseTimeoutMs)
    {
        lock (_closeGate)
            return _closing ??= Analytics.CloseAsync(timeoutMs);
    }

    public async ValueTask DisposeAsync()
    {
        await CloseAsync().ConfigureAwait(false);
        _ownedHttpClient?.Dispose();
    }

    private static Dictionary<string, string?> ProcessEnvironment()
    {
        var result = new Dictionary<string, string?>();
        foreach (DictionaryEntry entry in System.Environment.GetEnvironmentVariables())
            result[(string)entry.Key] = entry.Value as string;
        return result;
    }
}
