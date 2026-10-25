using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Net.Http;
using System.Text;
using System.Threading.Tasks;
using Baziness;

internal static class Program
{
    private static readonly HttpClient Client = new HttpClient();
    private static string controlBase;
    private static string apiBase;
    private static int passed;
    private static readonly List<string> Failures = new List<string>();

    private static async Task<int> Main()
    {
        var hub = StartFakeHub();
        try
        {
            return await RunAll();
        }
        finally
        {
            hub.Kill();
            hub.Dispose();
        }
    }

    private static async Task<int> RunAll()
    {
        await Test("page URLs carry the parameters the wiki lists", () =>
        {
            var shop = PageUrl.Build(new PageUrlInput
            {
                PagesBase = "https://baziness.com/", Page = BazinessPage.Shop, PackageName = "com.example.game",
                GameName = "یاتزی", LinkCode = "lc+1", TopInset = 80
            });
            Equal(shop.Split('?')[0], "https://baziness.com/shop");
            Check(shop.Contains("game_name=%DB%8C%D8%A7%D8%AA%D8%B2%DB%8C"), "game name encoded");
            Check(shop.Contains("sdkType=unity") && shop.Contains("linkCode=lc%2B1") && shop.Contains("redirect=shop"), "core params");
            Check(!shop.Contains("allowGuest") && !shop.Contains("linkedToken"), "no allowGuest, no linkedToken on the shop");
            Check(shop.Contains("top=80"), "notch inset");
            var login = PageUrl.Build(new PageUrlInput { PagesBase = "https://baziness.com", Page = BazinessPage.Login, PackageName = "p" });
            Check(login.StartsWith("https://baziness.com/?") && login.Contains("allowGuest=false"), "login at the root");
            return Task.CompletedTask;
        });
        await Test("page messages from a native web view and from an iframe", () =>
        {
            Equal(PageMessage.Parse("close").Type, PageMessageType.Close);
            var login = PageMessage.Parse("unity:login:eyJ.abc");
            Equal(login.Type, PageMessageType.Login);
            Equal(login.Data, "eyJ.abc");
            Equal(PageMessage.Parse("login").Data, null);
            Equal(PageMessage.Parse("{\"type\":\"login\",\"data\":{\"token\":\"t\"}}").Data, "t");
            Equal(PageMessage.Parse("open_url:https://fal.example/?linkCode=x").Data, "https://fal.example/?linkCode=x");
            Equal(PageMessage.Parse("open_url:javascript:alert(1)"), null);
            Equal(PageMessage.Parse("share_text:Hello%20world").Data, "Hello world");
            Equal(PageMessage.Parse("whatever"), null);
            return Task.CompletedTask;
        });
        await Test("deep links: link code and first-touch attribution", () =>
        {
            var launch = LaunchParams.Parse("yatzy://open?linkCode=abc&utm_source=fal&utm_medium=cross_promo&bz_lc=c1", new DateTime(2026, 10, 24, 10, 0, 0, DateTimeKind.Utc));
            Equal(launch.LinkCode, "abc");
            Equal(launch.Attribution.utmSource, "fal");
            Equal(launch.Attribution.campaignCode, "c1");
            Equal(launch.Attribution.landedAt, "2026-10-24T10:00:00.000Z");
            Equal(LaunchParams.Parse("yatzy://open", DateTime.UtcNow).Attribution, null);
            return Task.CompletedTask;
        });
        await Test("JSON round trip (dictionaries, numbers, unicode)", () =>
        {
            var json = MiniJson.Serialize(new Dictionary<string, object> { ["a"] = new List<object> { 1, 2.5, true, null }, ["b"] = "x\"é", ["skip"] = null });
            Equal(json, "{\"a\":[1,2.5,true,null],\"b\":\"x\\\"é\"}");
            var back = MiniJson.Object(MiniJson.Deserialize(json));
            Equal(MiniJson.String(back, "b"), "x\"é");
            return Task.CompletedTask;
        });
        await Test("session: the launch link code is sent once, the token is reused", async () =>
        {
            var server = await GameServer.Create();
            var sessions = new SessionManager(server, new DeviceInfo { deviceId = "unity-1", platform = "Android", store = "CafeBazaar" });
            sessions.UseLaunch(new LaunchParams { LinkCode = "lc.stale" }, null);
            await Throws(() => sessions.Get());
            var first = await sessions.Get();
            var again = await sessions.Get();
            Equal(again.AccessToken, first.AccessToken);
            Equal(string.Join(",", server.Calls), "session:lc.stale,session:-");
        });
        await Test("coin balance with the player token", async () =>
        {
            var server = await GameServer.Create();
            var sessions = new SessionManager(server, new DeviceInfo { deviceId = "unity-2" });
            await sessions.Get();
            Equal(await new CoinBalance(new ClientHttp(), apiBase, sessions.Token).Get(), 0L);
        });
        await Test("analytics: persisted queue, server-only names refused, one batch sent", async () =>
        {
            var server = await GameServer.Create();
            var sessions = new SessionManager(server, new DeviceInfo { deviceId = "unity-3" });
            await sessions.Get();
            var storage = new MemoryQueueStorage();
            var warnings = new List<string>();
            var analytics = new DeviceAnalytics(new ClientHttp(), apiBase, sessions.Token, storage) { SessionId = "s-1", Warn = warnings.Add };
            Check(analytics.Track("level_complete", 1200, new Dictionary<string, object> { ["level"] = 7 }), "accepted");
            Check(!analytics.Track("session_start"), "server-only refused");
            Check(!analytics.Track("Level Complete"), "invalid name refused");
            Equal(warnings.Count, 2);
            Check(storage.Load() != null, "persisted before sending");

            var reloaded = new DeviceAnalytics(new ClientHttp(), apiBase, sessions.Token, storage) { SessionId = "s-1" };
            Equal(reloaded.Pending, 1);
            await reloaded.Flush();
            Equal(reloaded.Pending, 0);
            Equal(storage.Load(), null);
            var events = (List<object>)MiniJson.Object(await Control("state", null))["deviceEvents"];
            Equal(events.Count, 1);
            var sent = MiniJson.Object(events[0]);
            Equal(MiniJson.String(sent, "eventKey"), "level_complete");
            Equal(MiniJson.String(MiniJson.Object(sent["props"]), "level"), "7");
            Equal(MiniJson.String(sent, "sessionId"), "s-1");
        });
        await Test("analytics: kept while the platform is down, sent on pause", async () =>
        {
            var server = await GameServer.Create();
            var sessions = new SessionManager(server, new DeviceInfo { deviceId = "unity-4" });
            await sessions.Get();
            await Control("fail", "{\"path\":\"/api/analytics/events/batch\",\"status\":503,\"times\":1}");
            var analytics = new DeviceAnalytics(new ClientHttp(), apiBase, sessions.Token, new MemoryQueueStorage());
            analytics.Track("tutorial_complete");
            await analytics.Flush();
            Equal(analytics.Pending, 1);
            await analytics.Flush(true);
            Equal(analytics.Pending, 0);
        });

        Console.WriteLine($"{passed} passed, {Failures.Count} failed");
        foreach (var failure in Failures) Console.WriteLine("  FAIL " + failure);
        return Failures.Count == 0 ? 0 : 1;
    }

    /// <summary>A game server in miniature: what a real one does with the server SDK, straight against the fake hub.</summary>
    private sealed class GameServer : IGameBackend
    {
        private string clientToken;
        private long userId;
        public readonly List<string> Calls = new List<string>();

        public static async Task<GameServer> Create()
        {
            var answer = await Post("/client/auth", "{\"clientId\":12,\"clientSecret\":\"fake-client-secret-12\"}", null);
            return new GameServer { clientToken = MiniJson.String(answer, "token") };
        }

        public async Task<BackendSession> Session(SessionRequest request)
        {
            Calls.Add("session:" + (request.LinkCode ?? "-"));
            var answer = await Post("/v2/client/create-user", MiniJson.Serialize(new Dictionary<string, object>
            {
                ["deviceId"] = request.Device.deviceId, ["platform"] = "Android", ["store"] = "CafeBazaar", ["linkCode"] = request.LinkCode
            }), clientToken);
            var tokens = MiniJson.Object(answer["tokens"]);
            userId = MiniJson.Long(answer, "userId");
            return BackendSession.FromDictionary(new Dictionary<string, object>
            {
                ["userId"] = answer["userId"], ["isLinkedToAccount"] = answer["isLinkedToAccount"],
                ["accessToken"] = tokens["accessToken"], ["accessTokenExpiresAt"] = tokens["accessTokenExpiresAt"]
            });
        }

        public async Task<string> LinkCode()
        {
            return MiniJson.String(await Post("/v2/client/link-code/" + userId, "", clientToken), "code");
        }

        public Task<Dictionary<string, object>> Login(string token) => Task.FromResult(new Dictionary<string, object>());
        public Task Logout() => Task.CompletedTask;

        private static async Task<Dictionary<string, object>> Post(string path, string body, string token)
        {
            var request = new HttpRequestMessage(HttpMethod.Post, apiBase + path) { Content = new StringContent(body, Encoding.UTF8, "application/json") };
            if (token != null) request.Headers.Add("Authorization", "Bearer " + token);
            var response = await Client.SendAsync(request);
            var text = await response.Content.ReadAsStringAsync();
            if (!response.IsSuccessStatusCode) throw new BackendException(path + ": " + text, (int)response.StatusCode);
            return MiniJson.Object(MiniJson.Deserialize(text));
        }
    }

    /// <summary><see cref="IHttp"/> over HttpClient, standing in for UnityWebRequest.</summary>
    private sealed class ClientHttp : IHttp
    {
        public async Task<HttpResult> Send(string method, string url, string jsonBody, IDictionary<string, string> headers)
        {
            var request = new HttpRequestMessage(new HttpMethod(method), url);
            if (jsonBody != null) request.Content = new StringContent(jsonBody, Encoding.UTF8, "application/json");
            foreach (var header in headers.Where(h => h.Key != "Content-Type")) request.Headers.TryAddWithoutValidation(header.Key, header.Value);
            try
            {
                var response = await Client.SendAsync(request);
                return new HttpResult { Status = (int)response.StatusCode, Body = await response.Content.ReadAsStringAsync() };
            }
            catch (HttpRequestException)
            {
                return new HttpResult { Status = 0 };
            }
        }
    }

    private static async Task Test(string name, Func<Task> body)
    {
        try
        {
            await Control("reset", "{}");
            await body();
            passed++;
            Console.WriteLine("  ok   " + name);
        }
        catch (Exception error)
        {
            Failures.Add(name + ": " + error.Message);
            Console.WriteLine("  FAIL " + name + ": " + error.Message);
        }
    }

    private static void Check(bool condition, string what)
    {
        if (!condition) throw new Exception("expected: " + what);
    }

    private static void Equal(object actual, object expected)
    {
        if (!Equals(actual, expected)) throw new Exception($"expected <{expected}> but was <{actual}>");
    }

    private static async Task Throws(Func<Task> body)
    {
        try
        {
            await body();
        }
        catch (Exception)
        {
            return;
        }
        throw new Exception("expected an exception");
    }

    private static async Task<object> Control(string path, string body)
    {
        var response = body == null
            ? await Client.GetAsync(controlBase + path)
            : await Client.PostAsync(controlBase + path, new StringContent(body, Encoding.UTF8, "application/json"));
        return MiniJson.Deserialize(await response.Content.ReadAsStringAsync());
    }

    private static Process StartFakeHub()
    {
        var script = Path.GetFullPath(Path.Combine(AppContext.BaseDirectory, "../../../../../../tools/fake-hub/fake-hub.mjs"));
        var process = Process.Start(new ProcessStartInfo("node", $"\"{script}\" 0") { RedirectStandardOutput = true, UseShellExecute = false });
        var line = process.StandardOutput.ReadLine() ?? "";
        if (!line.StartsWith("fake-hub listening on ")) throw new Exception("fake hub did not start: " + line);
        var port = line.Substring("fake-hub listening on ".Length).Trim();
        controlBase = $"http://127.0.0.1:{port}/__control/";
        apiBase = $"http://127.0.0.1:{port}/api";
        return process;
    }
}
