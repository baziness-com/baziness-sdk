using System.Diagnostics;
using System.Net.Http.Json;
using System.Text.Json;

namespace Baziness.Server.Tests;

/// <summary>Runs the shared fake platform (<c>tools/fake-hub</c>), the same one the other SDKs' tests use. Needs Node 18+.</summary>
public sealed class FakeHub : IAsyncLifetime
{
    public const long ClientId = 12;
    public const string ClientSecret = "fake-client-secret-12";
    public const long OtherClientId = 13;
    public const string OtherClientSecret = "fake-client-secret-13";

    private readonly HttpClient _control = new();
    private Process? _process;

    public string ApiBase { get; private set; } = "";
    public string PayBase { get; private set; } = "";

    public async Task InitializeAsync()
    {
        _process = Process.Start(new ProcessStartInfo("node")
        {
            ArgumentList = { FakeHubScript(), "0" },
            RedirectStandardOutput = true,
            UseShellExecute = false
        })!;

        var line = await _process.StandardOutput.ReadLineAsync();
        var port = line!.Split(' ').Last();
        ApiBase = $"http://127.0.0.1:{port}/api";
        PayBase = $"http://127.0.0.1:{port}/pay";
        _control.BaseAddress = new Uri($"http://127.0.0.1:{port}/__control/");
    }

    public Task DisposeAsync()
    {
        _process?.Kill(true);
        _process?.Dispose();
        _control.Dispose();
        return Task.CompletedTask;
    }

    /// <summary>An SDK on the fake hub.</summary>
    public BazinessServer Sdk(
        long clientId = ClientId,
        string clientSecret = ClientSecret,
        HttpOptions? http = null,
        AnalyticsOptions? analytics = null)
    {
        return new BazinessServer(new BazinessServerOptions
        {
            Environment = BazinessEnvironment.Staging,
            ClientId = clientId,
            ClientSecret = clientSecret,
            ApiBaseUrl = ApiBase,
            PayBaseUrl = PayBase,
            Http = http ?? new HttpOptions { RetryBaseMs = 10, DeadlineMs = 5000 },
            Analytics = analytics ?? new AnalyticsOptions { FlushIntervalMs = 60000 }
        });
    }

    public BazinessServer OtherGame() => Sdk(OtherClientId, OtherClientSecret);

    public async Task<JsonElement> Control(string path, object body)
    {
        var response = await _control.PostAsJsonAsync(path, body);
        var text = await response.Content.ReadAsStringAsync();
        return string.IsNullOrWhiteSpace(text) ? default : JsonDocument.Parse(text).RootElement;
    }

    public async Task<JsonElement> State() => JsonDocument.Parse(await _control.GetStringAsync("state")).RootElement;

    /// <summary>How many requests reached paths that start with this.</summary>
    public async Task<int> Requests(string pathPrefix)
    {
        var state = await State();
        return state.GetProperty("requests").EnumerateArray()
            .Count(r => r.GetProperty("path").GetString()!.StartsWith(pathPrefix, StringComparison.Ordinal));
    }

    public async Task<List<JsonElement>> ServerEvents()
    {
        var state = await State();
        return state.GetProperty("serverEvents").EnumerateArray().ToList();
    }

    private static string FakeHubScript()
    {
        for (var directory = new DirectoryInfo(AppContext.BaseDirectory); directory != null; directory = directory.Parent)
        {
            var script = Path.Combine(directory.FullName, "tools", "fake-hub", "fake-hub.mjs");
            if (File.Exists(script))
                return script;
        }

        throw new FileNotFoundException("tools/fake-hub/fake-hub.mjs not found above " + AppContext.BaseDirectory);
    }
}
