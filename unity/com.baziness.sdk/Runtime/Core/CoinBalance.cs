using System;
using System.Collections.Generic;
using System.Threading.Tasks;

namespace Baziness
{
    /// <summary>The player's Gita coin balance, read with their own token. Giving coins is a server call.</summary>
    public sealed class CoinBalance
    {
        private readonly IHttp http;
        private readonly string apiBase;
        private readonly Func<bool, Task<string>> token;

        public CoinBalance(IHttp http, string apiBase, Func<bool, Task<string>> token)
        {
            this.http = http;
            this.apiBase = apiBase.TrimEnd('/');
            this.token = token;
        }

        /// <summary>
        /// Read it when the session starts, when a Baziness page closes (the player may have spent coins),
        /// when the game returns to the foreground and after your server gave coins.
        /// </summary>
        public async Task<long> Get()
        {
            for (var attempt = 0; attempt < 2; attempt++)
            {
                var result = await http.Send("GET", apiBase + "/user/get-coin", null,
                    new Dictionary<string, string> { ["Authorization"] = "Bearer " + await token(attempt > 0) });
                if (result.Status == 401 && attempt == 0) continue;
                if (!result.Ok) throw new BackendException("get-coin: HTTP " + result.Status, result.Status);
                return MiniJson.Long(MiniJson.Object(MiniJson.Deserialize(result.Body)), "amount");
            }
            throw new BackendException("get-coin: unauthorized", 401);
        }
    }
}
