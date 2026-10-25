using System;
using System.Collections.Generic;

namespace Baziness
{
    /// <summary>
    /// First-touch attribution: campaign UTMs, a Baziness campaign link (<c>bz_lc</c>, <c>bz_click</c>)
    /// and the store install referrer. Collected on first open and kept; your server forwards it when
    /// it creates the player.
    /// </summary>
    [Serializable]
    public sealed class Attribution
    {
        public string utmSource;
        public string utmMedium;
        public string utmCampaign;
        public string utmContent;
        public string utmTerm;
        /// <summary>Campaign link code (<c>bz_lc</c>). Not the sign-in link code.</summary>
        public string campaignCode;
        public string clickId;
        /// <summary>Raw install referrer (Google Play Install Referrer, Cafe Bazaar, Myket).</summary>
        public string referrer;
        /// <summary>Android installer package, e.g. <c>com.farsitel.bazaar</c>.</summary>
        public string installer;
        public string landedAt;

        public bool IsEmpty =>
            string.IsNullOrEmpty(utmSource) && string.IsNullOrEmpty(utmMedium) && string.IsNullOrEmpty(utmCampaign) &&
            string.IsNullOrEmpty(utmContent) && string.IsNullOrEmpty(utmTerm) && string.IsNullOrEmpty(campaignCode) &&
            string.IsNullOrEmpty(clickId) && string.IsNullOrEmpty(referrer) && string.IsNullOrEmpty(installer);

        /// <summary>The JSON fields the server SDK reads (<c>Attribution.fromMap</c> / the Node type).</summary>
        public Dictionary<string, object> ToDictionary()
        {
            return new Dictionary<string, object>
            {
                ["utmSource"] = utmSource, ["utmMedium"] = utmMedium, ["utmCampaign"] = utmCampaign,
                ["utmContent"] = utmContent, ["utmTerm"] = utmTerm, ["campaignCode"] = campaignCode,
                ["clickId"] = clickId, ["referrer"] = referrer, ["installer"] = installer, ["landedAt"] = landedAt
            };
        }

        public static Attribution FromDictionary(Dictionary<string, object> values)
        {
            if (values == null) return null;
            return new Attribution
            {
                utmSource = MiniJson.String(values, "utmSource"), utmMedium = MiniJson.String(values, "utmMedium"),
                utmCampaign = MiniJson.String(values, "utmCampaign"), utmContent = MiniJson.String(values, "utmContent"),
                utmTerm = MiniJson.String(values, "utmTerm"), campaignCode = MiniJson.String(values, "campaignCode"),
                clickId = MiniJson.String(values, "clickId"), referrer = MiniJson.String(values, "referrer"),
                installer = MiniJson.String(values, "installer"), landedAt = MiniJson.String(values, "landedAt")
            };
        }
    }

    /// <summary>What a launch address (deep link or WebGL page URL) carried.</summary>
    public sealed class LaunchParams
    {
        /// <summary>
        /// One-time sign-in code: the Baziness app or another game opened this game for a known person.
        /// Sent with the next session request, once.
        /// </summary>
        public string LinkCode;
        public Attribution Attribution;

        /// <summary>
        /// Reads <c>linkCode</c>, <c>utm_*</c>, <c>bz_lc</c>, <c>bz_click</c> from a URL such as
        /// <c>mygame://open?linkCode=…</c> or <c>https://game.example/?utm_source=…</c>.
        /// </summary>
        public static LaunchParams Parse(string url, DateTime nowUtc)
        {
            var result = new LaunchParams();
            if (string.IsNullOrEmpty(url)) return result;
            var query = Query(url);
            query.TryGetValue("linkCode", out result.LinkCode);
            var attribution = new Attribution();
            query.TryGetValue("utm_source", out attribution.utmSource);
            query.TryGetValue("utm_medium", out attribution.utmMedium);
            query.TryGetValue("utm_campaign", out attribution.utmCampaign);
            query.TryGetValue("utm_content", out attribution.utmContent);
            query.TryGetValue("utm_term", out attribution.utmTerm);
            query.TryGetValue("bz_lc", out attribution.campaignCode);
            query.TryGetValue("bz_click", out attribution.clickId);
            if (!attribution.IsEmpty)
            {
                attribution.landedAt = nowUtc.ToString("yyyy-MM-ddTHH:mm:ss.fffZ", System.Globalization.CultureInfo.InvariantCulture);
                result.Attribution = attribution;
            }
            return result;
        }

        private static Dictionary<string, string> Query(string url)
        {
            var values = new Dictionary<string, string>();
            var start = url.IndexOf('?');
            if (start < 0) return values;
            var end = url.IndexOf('#', start);
            var query = end < 0 ? url.Substring(start + 1) : url.Substring(start + 1, end - start - 1);
            foreach (var pair in query.Split('&'))
            {
                if (pair.Length == 0) continue;
                var equals = pair.IndexOf('=');
                var key = Uri.UnescapeDataString((equals < 0 ? pair : pair.Substring(0, equals)).Replace('+', ' '));
                var value = equals < 0 ? "" : Uri.UnescapeDataString(pair.Substring(equals + 1).Replace('+', ' '));
                if (!values.ContainsKey(key) && value.Trim().Length > 0) values[key] = value.Trim();
            }
            return values;
        }
    }
}
