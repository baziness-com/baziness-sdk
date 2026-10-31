using System;
using System.Collections.Generic;
using System.Threading.Tasks;
using UnityEngine;

namespace Baziness
{
    /// <summary>Everything <see cref="BazinessSdk.Initialize(BazinessOptions)"/> needs.</summary>
    public sealed class BazinessOptions
    {
        public BazinessEnvironment Environment = BazinessEnvironment.Staging;
        /// <summary>Your platform package name (<c>packageName</c> on every page).</summary>
        public string PackageName;
        /// <summary>Your game name (<c>game_name</c> on the reward and game-offer pages).</summary>
        public string GameName;
        /// <summary><c>Direct</c>, <c>GooglePlay</c>, <c>AppStore</c>, <c>CafeBazaar</c> or <c>Myket</c>.</summary>
        public string Store = "Direct";
        /// <summary>Your server's side: sessions, link codes, login, logout. See <see cref="HttpGameBackend"/>.</summary>
        public IGameBackend Backend;
        /// <summary>How the built-in page view looks (backdrop, spinner, close button). Default: Yatzy's look.</summary>
        public PageViewStyle PageViewStyle;
        /// <summary>
        /// Your own page view, instead of the built-in one (the bundled web view on Android, iOS and macOS,
        /// the system browser elsewhere).
        /// </summary>
        public IPageView PageView;
        public string ApiBaseUrlOverride;
        public string PagesBaseUrlOverride;
        public IHttp Http;
        public IQueueStorage EventStorage;

        public static BazinessOptions From(BazinessSettings settings)
        {
            return new BazinessOptions
            {
                Environment = settings.environment,
                PackageName = settings.packageName,
                GameName = settings.gameName,
                Store = settings.store,
                PageViewStyle = settings.pageView,
                ApiBaseUrlOverride = settings.apiBaseUrlOverride,
                PagesBaseUrlOverride = settings.pagesBaseUrlOverride
            };
        }
    }

    /// <summary>
    /// The Baziness SDK for Unity games. Your game server holds the secret and uses the Baziness
    /// server SDK; this side shows Baziness pages, reads the coin balance, collects attribution and
    /// device info, and sends player analytics.
    /// <code>
    /// BazinessSdk.Initialize(new BazinessOptions {
    ///     Environment = BazinessEnvironment.Staging, PackageName = "com.example.game", GameName = "example",
    ///     Store = "CafeBazaar", Backend = new HttpGameBackend(new UnityHttp(), "https://api.example.com/baziness") });
    /// await BazinessSdk.StartAsync();
    /// await BazinessSdk.OpenPage(BazinessPage.Shop);
    /// </code>
    /// </summary>
    public static class BazinessSdk
    {
        private const string AttributionKey = "baziness_attribution";

        private static BazinessOptions options;
        private static SessionManager sessions;
        private static string apiBase;
        private static string pagesBase;
        private static IHttp http;
        private static BazinessPage? openPage;
        private static float openedAt;
        private static bool started;
        private static BazinessRunner runner;

        public static bool IsInitialized { get; private set; }
        public static BazinessEnvironment Environment => options?.Environment ?? BazinessEnvironment.Staging;
        public static DeviceInfo Device { get; private set; }
        /// <summary>First-touch attribution of this install, or null when it came with none.</summary>
        public static Attribution Attribution { get; private set; }
        public static BackendSession Session => sessions?.Current;
        public static bool IsLinkedToAccount => sessions?.Current?.IsLinkedToAccount ?? false;
        public static DeviceAnalytics Analytics { get; private set; }
        /// <summary>
        /// A Baziness page is on screen (or still sliding away). Skip your own back-button handling while it
        /// is: the page view closes on the same key press.
        /// </summary>
        public static bool IsPageOpen => options?.PageView?.IsOpen == true;
        public static CoinBalance Coins { get; private set; }
        public static ReferralRewards Referrals { get; private set; }

        /// <summary>A new session (or null after logout). Your server's extra fields are on <c>Raw</c>.</summary>
        public static event Action<BackendSession> SessionChanged;
        /// <summary>The player signed in on a page; your server verified and linked the token. Its answer is passed on.</summary>
        public static event Action<Dictionary<string, object>> LoggedIn;
        /// <summary>The player signed out on a page: delete local player data and start over as a new visitor.</summary>
        public static event Action LoggedOut;
        public static event Action<BazinessPage> PageOpened;
        /// <summary>A page closed: refresh the coin balance.</summary>
        public static event Action<BazinessPage> PageClosed;
        /// <summary>A page asked to share text. Default when nobody listens: copy it to the clipboard.</summary>
        public static event Action<string> ShareRequested;

        public static void Initialize(BazinessSettings settings, IGameBackend backend, IPageView pageView = null)
        {
            var initOptions = BazinessOptions.From(settings);
            initOptions.Backend = backend;
            initOptions.PageView = pageView;
            Initialize(initOptions);
        }

        public static void Initialize(BazinessOptions initOptions)
        {
            if (initOptions == null) throw new ArgumentNullException(nameof(initOptions));
            if (string.IsNullOrEmpty(initOptions.PackageName)) throw new ArgumentException("PackageName is required");
            if (initOptions.Backend == null) throw new ArgumentException("Backend is required (see HttpGameBackend)");
            options = initOptions;
            options.PageView ??= BazinessWebView.IsSupported
                ? BazinessWebView.Create(options.PageViewStyle)
                : new ExternalBrowserPageView();
            http = options.Http ?? new UnityHttp();
            apiBase = (string.IsNullOrEmpty(options.ApiBaseUrlOverride) ? BazinessUrls.Api(options.Environment) : options.ApiBaseUrlOverride).TrimEnd('/');
            pagesBase = (string.IsNullOrEmpty(options.PagesBaseUrlOverride) ? BazinessUrls.Pages(options.Environment) : options.PagesBaseUrlOverride).TrimEnd('/');

            Device = UnityDevice.Collect(options.Store);
            Attribution = LoadAttribution();
            sessions = new SessionManager(options.Backend, Device);
            sessions.Changed += session =>
            {
                if (!string.IsNullOrEmpty(session?.SessionId)) Analytics.SessionId = session.SessionId;
                SessionChanged?.Invoke(session);
            };
            Analytics = new DeviceAnalytics(http, apiBase, sessions.Token, options.EventStorage ?? new FileQueueStorage())
            {
                SessionId = Guid.NewGuid().ToString(),
                AppVersion = Application.version,
                Warn = Debug.LogWarning
            };
            Coins = new CoinBalance(http, apiBase, sessions.Token);
            Referrals = new ReferralRewards(http, apiBase, sessions.Token);

            // A launch from the Baziness app or another game: ?linkCode= on the deep link.
            HandleDeepLink(Application.absoluteURL, false);
            Application.deepLinkActivated -= OnDeepLink;
            Application.deepLinkActivated += OnDeepLink;
            if (Attribution == null && !string.IsNullOrEmpty(Device.installer))
            {
                // No campaign signal, but the store it came from still sets the channel.
                SaveAttribution(new Attribution { installer = Device.installer, landedAt = DateTime.UtcNow.ToString("o") });
            }

            if (runner == null)
            {
                var host = new GameObject("BazinessRunner") { hideFlags = HideFlags.HideInHierarchy };
                UnityEngine.Object.DontDestroyOnLoad(host);
                runner = host.AddComponent<BazinessRunner>();
            }
            IsInitialized = true;
        }

        /// <summary>Get the first session from your server (sends the launch link code and attribution).</summary>
        public static Task<BackendSession> StartAsync()
        {
            RequireInitialized();
            started = true;
            return sessions.Get();
        }

        /// <summary>Ask your server again, e.g. after your own login changed the player.</summary>
        public static Task<BackendSession> RefreshSessionAsync()
        {
            RequireInitialized();
            return sessions.Get(true);
        }

        /// <summary>A valid 15-minute access token, renewed through your server when needed.</summary>
        public static Task<string> GetTokenAsync()
        {
            RequireInitialized();
            return sessions.Token();
        }

        public static Task<long> GetCoinBalanceAsync()
        {
            RequireInitialized();
            return Coins.Get();
        }

        /// <summary>Referral rewards waiting on the referral page: show it as a badge on your referral button.</summary>
        public static Task<int> GetReferralRewardCountAsync()
        {
            RequireInitialized();
            return Referrals.Collectable();
        }

        /// <summary>Open a Baziness page over the game with a fresh link code from your server.</summary>
        public static async Task OpenPage(BazinessPage page, Dictionary<string, string> query = null)
        {
            RequireInitialized();
            if (options.PageView.IsOpen) return;
            await sessions.Get();
            var linkCode = await options.Backend.LinkCode();
            var safeArea = Screen.safeArea;
            var url = PageUrl.Build(new PageUrlInput
            {
                PagesBase = pagesBase,
                Page = page,
                PackageName = options.PackageName,
                GameName = options.GameName,
                LinkCode = linkCode,
                SdkType = options.PageView.SdkType,
                BuildStore = options.Store == "CafeBazaar" || options.Store == "Myket" ? options.Store : null,
                Platform = Device.platform,
                AppVersion = Application.version,
                TopInset = PageUrl.InsetPercent(Screen.height - safeArea.yMax, Screen.height),
                BottomInset = PageUrl.InsetPercent(safeArea.yMin, Screen.height),
                Query = query
            });
            openPage = page;
            openedAt = Time.realtimeSinceStartup;
            options.PageView.Open(url, raw => _ = OnPageMessage(raw), OnPageClosed);
            Analytics.Record("baziness:page:open", null, new Dictionary<string, object> { ["page"] = PageName(page) });
            PageOpened?.Invoke(page);
        }

        public static void ClosePage()
        {
            if (options?.PageView?.IsOpen == true) options.PageView.Close();
        }

        /// <summary>
        /// A deep link or launch URL (called for you on start and on <c>Application.deepLinkActivated</c>).
        /// A <c>linkCode</c> in it signs the player in as that Baziness person on the next session request.
        /// </summary>
        public static void HandleDeepLink(string url)
        {
            HandleDeepLink(url, true);
        }

        /// <summary>
        /// The raw store install referrer (Google Play Install Referrer API, Cafe Bazaar / Myket SDKs).
        /// Before the first session it goes to your server with the attribution; after it, straight to
        /// Baziness (accepted within 24 h of the first open).
        /// </summary>
        public static Task SetInstallReferrer(string referrer)
        {
            RequireInitialized();
            if (string.IsNullOrEmpty(referrer)) return Task.CompletedTask;
            var attribution = Attribution ?? new Attribution { landedAt = DateTime.UtcNow.ToString("o") };
            if (!string.IsNullOrEmpty(attribution.referrer)) return Task.CompletedTask;
            attribution.referrer = referrer;
            return RecordLateAttribution(attribution);
        }

        /// <summary>
        /// The install's campaign as your attribution SDK reports it (Metrix, Adjust, AppsFlyer, …), for
        /// installs the SDK could not read a campaign link for. First touch wins: ignored once the install
        /// has a campaign. Sent like <see cref="SetInstallReferrer"/>.
        /// </summary>
        public static Task SetCampaignAttribution(string utmSource, string utmMedium = null, string utmCampaign = null,
            string utmContent = null, string utmTerm = null)
        {
            RequireInitialized();
            if (string.IsNullOrEmpty(utmSource)) return Task.CompletedTask;
            var attribution = Attribution ?? new Attribution { landedAt = DateTime.UtcNow.ToString("o") };
            if (attribution.HasCampaign) return Task.CompletedTask;
            attribution.utmSource = utmSource;
            attribution.utmMedium = utmMedium;
            attribution.utmCampaign = utmCampaign;
            attribution.utmContent = utmContent;
            attribution.utmTerm = utmTerm;
            return RecordLateAttribution(attribution);
        }

        private static async Task RecordLateAttribution(Attribution attribution)
        {
            attribution.installer ??= Device.installer;
            SaveAttribution(attribution);
            if (sessions.Current == null) return; // goes with the first session request
            var result = await http.Send("POST", apiBase + "/analytics/attribution", MiniJson.Serialize(attribution.ToDictionary()),
                new Dictionary<string, string>
                {
                    ["Content-Type"] = "application/json", ["Authorization"] = "Bearer " + await sessions.Token()
                });
            if (!result.Ok) Debug.LogWarning("[baziness] attribution not recorded: HTTP " + result.Status);
        }

        private static void OnDeepLink(string url)
        {
            HandleDeepLink(url, true);
        }

        private static void HandleDeepLink(string url, bool refresh)
        {
            if (string.IsNullOrEmpty(url) || sessions == null) return;
            var launch = LaunchParams.Parse(url, DateTime.UtcNow);
            if (Attribution == null && launch.Attribution != null)
            {
                launch.Attribution.installer = Device.installer;
                SaveAttribution(launch.Attribution);
            }
            sessions.UseLaunch(launch, Attribution);
            // Arriving from another game while running: switch to that person now.
            if (refresh && started && !string.IsNullOrEmpty(launch.LinkCode)) _ = sessions.Get(true);
        }

        private static async Task OnPageMessage(string raw)
        {
            var message = PageMessage.Parse(raw);
            if (message == null) return;
            var page = openPage.HasValue ? PageName(openPage.Value) : "page";
            try
            {
                switch (message.Type)
                {
                    case PageMessageType.Close:
                        ClosePage();
                        break;
                    case PageMessageType.Token:
                        break; // a handshake when a page loads, never a sign-in
                    case PageMessageType.Login:
                        var answer = message.Data != null ? await options.Backend.Login(message.Data) : null;
                        await sessions.Get(true);
                        Analytics.Record("baziness:page:login", null, new Dictionary<string, object> { ["page"] = page });
                        LoggedIn?.Invoke(answer);
                        if (message.Data != null) ClosePage();
                        break;
                    case PageMessageType.Logout:
                        await options.Backend.Logout();
                        Analytics.Record("baziness:page:logout", null, new Dictionary<string, object> { ["page"] = page });
                        sessions.Clear();
                        ClosePage();
                        LoggedOut?.Invoke();
                        break;
                    case PageMessageType.OpenUrl:
                        // Opening another game from a page: its URL already carries a link code (SSO).
                        Application.OpenURL(message.Data);
                        break;
                    case PageMessageType.ShareText:
                        if (ShareRequested != null) ShareRequested(message.Data);
                        else GUIUtility.systemCopyBuffer = message.Data;
                        break;
                }
            }
            catch (Exception error)
            {
                Debug.LogWarning("[baziness] page message " + message.Type + " failed: " + error.Message);
            }
        }

        private static void OnPageClosed()
        {
            if (!openPage.HasValue) return;
            var page = openPage.Value;
            openPage = null;
            Analytics.Record("baziness:page:close", Math.Round(Time.realtimeSinceStartup - openedAt),
                new Dictionary<string, object> { ["page"] = PageName(page) });
            PageClosed?.Invoke(page);
        }

        private static string PageName(BazinessPage page)
        {
            return page == BazinessPage.GameOffer ? "game-offer" : page.ToString().ToLowerInvariant();
        }

        private static Attribution LoadAttribution()
        {
            var json = PlayerPrefs.GetString(AttributionKey, "");
            if (string.IsNullOrEmpty(json)) return null;
            try
            {
                return Attribution.FromDictionary(MiniJson.Object(MiniJson.Deserialize(json)));
            }
            catch (FormatException)
            {
                return null;
            }
        }

        private static void SaveAttribution(Attribution attribution)
        {
            Attribution = attribution;
            PlayerPrefs.SetString(AttributionKey, MiniJson.Serialize(attribution.ToDictionary()));
            PlayerPrefs.Save();
            sessions?.UseLaunch(null, attribution);
        }

        private static void RequireInitialized()
        {
            if (!IsInitialized) throw new InvalidOperationException("BazinessSdk.Initialize must be called first");
        }
    }
}
