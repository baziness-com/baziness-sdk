using System;
using System.Collections.Generic;
using System.Text;

namespace Baziness
{
    /// <summary>The Baziness pages a game opens.</summary>
    public enum BazinessPage
    {
        /// <summary>Sign-in (the site root).</summary>
        Login,
        Profile,
        /// <summary>The «انتخاب جایزه» reward shop.</summary>
        Shop,
        /// <summary>Your game's offer page, once, during the tutorial.</summary>
        GameOffer,
        Referral
    }

    public sealed class PageUrlInput
    {
        public string PagesBase;
        public BazinessPage Page;
        public string PackageName;
        public string GameName;
        public string LinkCode;
        /// <summary><c>unity</c> for a native web view (messages as <c>unity:</c> navigations), <c>js</c> for an iframe.</summary>
        public string SdkType = "unity";
        public string BuildStore;
        public string Platform;
        public string AppVersion;
        /// <summary>
        /// Safe-area insets in <b>percent of the screen height</b> (the page applies them as <c>vh</c>), so
        /// it keeps clear of a notch. <see cref="PageUrl.InsetPercent"/> converts pixels.
        /// </summary>
        public int TopInset;
        public int BottomInset;
        public Dictionary<string, string> Query;
    }

    public static class PageUrl
    {
        public static string Path(BazinessPage page)
        {
            switch (page)
            {
                case BazinessPage.Profile: return "/profile";
                case BazinessPage.Shop: return "/shop";
                case BazinessPage.GameOffer: return "/game-offer";
                case BazinessPage.Referral: return "/referral";
                default: return "/";
            }
        }

        /// <summary>A safe-area inset in pixels as the page's <c>top</c> / <c>bot</c> take it: percent of the screen height, rounded up.</summary>
        public static int InsetPercent(float insetPixels, float screenHeight)
        {
            if (insetPixels <= 0 || screenHeight <= 0) return 0;
            return (int)Math.Ceiling(Math.Round(insetPixels / screenHeight * 100, 3));
        }

        /// <summary>The page address with every parameter the page needs (see the wiki's page table).</summary>
        public static string Build(PageUrlInput input)
        {
            var query = new List<KeyValuePair<string, string>>();
            void Add(string key, string value)
            {
                if (!string.IsNullOrEmpty(value)) query.Add(new KeyValuePair<string, string>(key, value));
            }

            if (input.Page == BazinessPage.Shop || input.Page == BazinessPage.GameOffer) Add("game_name", input.GameName);
            Add("packageName", input.PackageName);
            Add("sdkType", input.SdkType);
            Add("linkCode", input.LinkCode);
            if (input.Page == BazinessPage.Profile) Add("redirect", "profile");
            if (input.Page == BazinessPage.Shop) Add("redirect", "shop");
            if (input.Page == BazinessPage.Login || input.Page == BazinessPage.Profile || input.Page == BazinessPage.GameOffer)
                Add("allowGuest", "false");
            Add("buildStore", input.BuildStore);
            Add("platform", input.Platform);
            Add("version", input.AppVersion);
            Add("sdkVersion", BazinessSdkInfo.Version);
            if (input.TopInset > 0) Add("top", input.TopInset.ToString());
            if (input.BottomInset > 0) Add("bot", input.BottomInset.ToString());
            if (input.Query != null)
                foreach (var pair in input.Query) Add(pair.Key, pair.Value);

            var builder = new StringBuilder(input.PagesBase.TrimEnd('/')).Append(Path(input.Page)).Append('?');
            for (var i = 0; i < query.Count; i++)
            {
                if (i > 0) builder.Append('&');
                builder.Append(Uri.EscapeDataString(query[i].Key)).Append('=').Append(Uri.EscapeDataString(query[i].Value));
            }
            return builder.ToString();
        }
    }

    public enum PageMessageType
    {
        Close,
        /// <summary>The player signed in. <see cref="PageMessage.Data"/> is the token, or null when linked in place.</summary>
        Login,
        /// <summary>A silent handshake when a page loads: never a sign-in.</summary>
        Token,
        Logout,
        OpenUrl,
        ShareText
    }

    public sealed class PageMessage
    {
        public PageMessageType Type;
        public string Data;

        /// <summary>
        /// A page message: <c>close</c>, <c>login:&lt;token&gt;</c>, <c>open_url:&lt;url&gt;</c> … from a native
        /// web view (the <c>unity:</c> prefix optional), or <c>{"type":…,"data":…}</c> from an iframe.
        /// Null for anything else.
        /// </summary>
        public static PageMessage Parse(string raw)
        {
            if (string.IsNullOrEmpty(raw)) return null;
            raw = raw.Trim();
            if (raw.StartsWith("{")) return ParseJson(raw);
            if (raw.StartsWith("unity:")) raw = raw.Substring("unity:".Length);
            var colon = raw.IndexOf(':');
            var type = colon < 0 ? raw : raw.Substring(0, colon);
            var data = colon < 0 ? null : raw.Substring(colon + 1);
            return Create(type, data);
        }

        private static PageMessage ParseJson(string raw)
        {
            try
            {
                var obj = MiniJson.Object(MiniJson.Deserialize(raw));
                obj.TryGetValue("data", out var payload);
                var data = payload as string ?? (payload is Dictionary<string, object> inner ? MiniJson.String(inner, "token") : null);
                return Create(MiniJson.String(obj, "type"), data);
            }
            catch (FormatException)
            {
                return null;
            }
        }

        private static PageMessage Create(string type, string data)
        {
            switch (type)
            {
                case "close": return new PageMessage { Type = PageMessageType.Close };
                case "logout": return new PageMessage { Type = PageMessageType.Logout };
                case "token": return new PageMessage { Type = PageMessageType.Token };
                case "login":
                    return new PageMessage { Type = PageMessageType.Login, Data = string.IsNullOrEmpty(data) ? null : data };
                case "open_url":
                    return data != null && (data.StartsWith("https://") || data.StartsWith("http://"))
                        ? new PageMessage { Type = PageMessageType.OpenUrl, Data = data }
                        : null;
                case "share_text":
                    return data == null ? null : new PageMessage { Type = PageMessageType.ShareText, Data = Uri.UnescapeDataString(data) };
                default: return null;
            }
        }
    }
}
