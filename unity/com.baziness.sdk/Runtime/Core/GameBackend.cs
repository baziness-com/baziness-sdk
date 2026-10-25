using System;
using System.Collections.Generic;
using System.Threading.Tasks;

namespace Baziness
{
    /// <summary>What the device sends your server when it needs a Baziness session.</summary>
    public sealed class SessionRequest
    {
        /// <summary>One-time code from the launch deep link; only on the first request after a launch.</summary>
        public string LinkCode;
        /// <summary>First-touch attribution; your server forwards it when it creates the player.</summary>
        public Attribution Attribution;
        public DeviceInfo Device;

        public Dictionary<string, object> ToDictionary()
        {
            var values = new Dictionary<string, object> { ["device"] = Device?.ToDictionary() };
            if (!string.IsNullOrEmpty(LinkCode)) values["linkCode"] = LinkCode;
            if (Attribution != null && !Attribution.IsEmpty) values["attribution"] = Attribution.ToDictionary();
            return values;
        }
    }

    /// <summary>What your server answers: the result of <c>players.signIn</c> / <c>players.session</c> on the server SDK.</summary>
    public sealed class BackendSession
    {
        public long UserId;
        public bool IsLinkedToAccount;
        /// <summary>15-minute access token. Never a refresh token: that one stays on your server.</summary>
        public string AccessToken;
        public DateTime AccessTokenExpiresAtUtc;
        /// <summary>The server's session id, so device events are grouped with the server's session events.</summary>
        public string SessionId;
        /// <summary>Everything your server sent, including your own fields (for example a player to switch to).</summary>
        public Dictionary<string, object> Raw;

        public static BackendSession FromDictionary(Dictionary<string, object> values)
        {
            var expires = MiniJson.String(values, "accessTokenExpiresAt");
            return new BackendSession
            {
                UserId = MiniJson.Long(values, "userId"),
                IsLinkedToAccount = MiniJson.Bool(values, "isLinkedToAccount"),
                AccessToken = MiniJson.String(values, "accessToken"),
                AccessTokenExpiresAtUtc = DateTime.TryParse(expires, System.Globalization.CultureInfo.InvariantCulture,
                    System.Globalization.DateTimeStyles.AdjustToUniversal | System.Globalization.DateTimeStyles.AssumeUniversal, out var at)
                    ? at
                    : DateTime.MinValue,
                SessionId = MiniJson.String(values, "sessionId"),
                Raw = values
            };
        }
    }

    /// <summary>
    /// Your game server's side of the integration. The device never holds a Baziness secret: it asks
    /// your server, which uses the server SDK. <see cref="HttpGameBackend"/> calls the conventional
    /// routes; implement this yourself to go over your own connection (for example SmartFox).
    /// </summary>
    public interface IGameBackend
    {
        /// <summary>A session for the current player (<c>players.signIn</c> on your server).</summary>
        Task<BackendSession> Session(SessionRequest request);
        /// <summary>A link code for opening one Baziness page (<c>players.linkCode</c> on your server).</summary>
        Task<string> LinkCode();
        /// <summary>A page sent <c>login</c>: verify the token on your server and link or switch. Returns your server's answer.</summary>
        Task<Dictionary<string, object>> Login(string token);
        /// <summary>A page sent <c>logout</c>: end the session on your server.</summary>
        Task Logout();
    }

    public sealed class BackendException : Exception
    {
        public readonly int Status;

        public BackendException(string message, int status) : base(message)
        {
            Status = status;
        }
    }

    /// <summary>
    /// An <see cref="IGameBackend"/> over four JSON routes under <c>baseUrl</c> on your server:
    /// <c>POST /session</c>, <c>/link-code</c>, <c>/login</c>, <c>/logout</c> (see the server SDK recipes).
    /// </summary>
    public sealed class HttpGameBackend : IGameBackend
    {
        private readonly IHttp http;
        private readonly string baseUrl;
        private readonly Func<IDictionary<string, string>> headers;

        /// <param name="headers">Your game's own player authentication, added to every call.</param>
        public HttpGameBackend(IHttp http, string baseUrl, Func<IDictionary<string, string>> headers = null)
        {
            this.http = http;
            this.baseUrl = baseUrl.TrimEnd('/');
            this.headers = headers;
        }

        public async Task<BackendSession> Session(SessionRequest request)
        {
            return BackendSession.FromDictionary(await Call("/session", request.ToDictionary()));
        }

        public async Task<string> LinkCode()
        {
            var answer = await Call("/link-code", new Dictionary<string, object>());
            var code = MiniJson.String(answer, "linkCode") ?? MiniJson.String(answer, "code");
            if (string.IsNullOrEmpty(code)) throw new BackendException("/link-code: no code in the answer", 200);
            return code;
        }

        public Task<Dictionary<string, object>> Login(string token)
        {
            return Call("/login", new Dictionary<string, object> { ["token"] = token });
        }

        public Task Logout()
        {
            return Call("/logout", new Dictionary<string, object>());
        }

        private async Task<Dictionary<string, object>> Call(string path, Dictionary<string, object> body)
        {
            var requestHeaders = new Dictionary<string, string> { ["Content-Type"] = "application/json" };
            var extra = headers?.Invoke();
            if (extra != null)
                foreach (var pair in extra) requestHeaders[pair.Key] = pair.Value;
            var result = await http.Send("POST", baseUrl + path, MiniJson.Serialize(body), requestHeaders);
            if (!result.Ok) throw new BackendException(path + ": HTTP " + result.Status, result.Status);
            return MiniJson.Object(string.IsNullOrEmpty(result.Body) ? null : MiniJson.Deserialize(result.Body));
        }
    }
}
