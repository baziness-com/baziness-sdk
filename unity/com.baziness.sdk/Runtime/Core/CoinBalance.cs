using System;
using System.Collections.Generic;
using System.Globalization;
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
            var body = await PlayerCall.Get(http, apiBase + "/user/get-coin", token, "get-coin");
            return MiniJson.Long(MiniJson.Object(MiniJson.Deserialize(body)), "amount");
        }
    }

    /// <summary>Referral rewards the player can collect on the referral page: a badge for your referral button.</summary>
    public sealed class ReferralRewards
    {
        private readonly IHttp http;
        private readonly string apiBase;
        private readonly Func<bool, Task<string>> token;

        public ReferralRewards(IHttp http, string apiBase, Func<bool, Task<string>> token)
        {
            this.http = http;
            this.apiBase = apiBase.TrimEnd('/');
            this.token = token;
        }

        /// <summary>Invited friends whose reward is waiting. Read it on start and when the referral page closes.</summary>
        public async Task<int> Collectable()
        {
            var body = await PlayerCall.Get(http, apiBase + "/user/referral-collectable-accounts-count", token, "referral-count");
            return Convert.ToInt32(MiniJson.Deserialize(body), CultureInfo.InvariantCulture);
        }
    }

    /// <summary>A GET with the player's token that asks your server for a new token once when it answers 401.</summary>
    internal static class PlayerCall
    {
        public static async Task<string> Get(IHttp http, string url, Func<bool, Task<string>> token, string operation)
        {
            for (var attempt = 0; attempt < 2; attempt++)
            {
                var result = await http.Send("GET", url, null,
                    new Dictionary<string, string> { ["Authorization"] = "Bearer " + await token(attempt > 0) });
                if (result.Status == 401 && attempt == 0) continue;
                if (!result.Ok) throw new BackendException(operation + ": HTTP " + result.Status, result.Status);
                return result.Body;
            }
            throw new BackendException(operation + ": unauthorized", 401);
        }
    }
}
