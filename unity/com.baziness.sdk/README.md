# Baziness SDK for Unity (`com.baziness.sdk`)

Baziness for the **player's device** in a Unity game (2021.3+): Baziness pages in a built-in web view,
the Gita coin balance, sign-in hand-over from other games (link codes in deep links), install
attribution, device info and player analytics. It holds no secret: sessions and link codes come from
your game server, which uses the Baziness server SDK (Node or Java).

## Install

Package Manager → **Add package from git URL**:

`https://github.com/baziness-com/baziness-sdk.git?path=/unity/com.baziness.sdk#v1.2.0`

That is all: the web view comes with it. The package bundles
[gree unity-webview](https://github.com/gree/unity-webview) (zlib, see
[Third Party Notices](Third%20Party%20Notices.md)) for Android, iOS and macOS (the editor too); on
Windows, Linux and WebGL pages open in the system browser.

> If your project already has gree unity-webview (`Assets/Plugins/WebViewObject.cs`, `WebView.bundle`,
> `iOS/WebView*.mm`, `Android/WebViewPlugin-*.aar.tmpl`, `Editor/UnityWebViewPostprocessBuild.cs`, or the
> `net.gree.unity-webview` package), remove it: two copies of its native plugins break the build.
> `WebViewObject` keeps its name in this package, so your own code that uses it compiles unchanged.

## Quick start

```csharp
// Your server's four Baziness routes (/session, /link-code, /login, /logout) over HTTP…
var backend = new HttpGameBackend(new UnityHttp(), settings.gameServerUrl, () => MyAuthHeaders());
// …or implement IGameBackend over your own socket (SmartFox, WebSocket): see the wiki.

BazinessSdk.Initialize(settings, backend);            // pages open in the built-in web view
BazinessSdk.PageClosed += _ => RefreshBalance();
BazinessSdk.LoggedOut += () => StartOverAsNewVisitor();
var session = await BazinessSdk.StartAsync();         // throws when Baziness is unavailable: carry on without it
await BazinessSdk.OpenPage(BazinessPage.Shop);
long balance = await BazinessSdk.GetCoinBalanceAsync();
BazinessSdk.Analytics.LevelComplete("7", 1200);       // one method per event
```

## The page view

`BazinessWebView` shows a page over the game: a backdrop slides up, a spinner turns while the page
loads, a close button appears when it takes longer than three seconds, the page slides down when it
closes, and the Android back button closes it. Change its look with `PageViewStyle` (backdrop colour,
spinner and close sprites, sizes, positions, timings, canvas sorting order) in the settings asset or in
`BazinessOptions.PageViewStyle`; the defaults are Yatzy's. To show pages your own way, pass an
`IPageView` (`SdkType`, `IsOpen`, `Open`, `Close`) as `BazinessOptions.PageView`.

## API

| | |
| --- | --- |
| `Initialize`, `StartAsync`, `RefreshSessionAsync` | session from your server; call `RefreshSessionAsync` after your own login changed the player or the connection to your server was re-established |
| `Session`, `IsLinkedToAccount`, `SessionChanged` | the current session (null after logout); linked = signed in with a phone number |
| `OpenPage(BazinessPage.Login / Profile / Shop / GameOffer / Referral)`, `ClosePage` | pages with a fresh link code, safe-area insets, store and platform |
| `PageOpened`, `PageClosed`, `LoggedIn`, `LoggedOut`, `ShareRequested` | page events (`LoggedIn` carries your server's `/login` answer) |
| `GetCoinBalanceAsync`, `GetReferralRewardCountAsync` | read with the player's 15-minute token |
| `Analytics.PurchaseStarted / PurchaseFailed / AdImpression / AdRevenue / TutorialBegin / TutorialComplete / LevelStart / LevelComplete / LevelFail / ResourceEarn / ResourceSpend` | player analytics, queued in a file and sent in batches |
| `HandleDeepLink` (automatic), `SetInstallReferrer`, `SetCampaignAttribution` | first-touch attribution: deep-link `utm_*` / `bz_lc` / `bz_click`, store referrer, the campaign your attribution SDK reports |
| `Device`, `Attribution` | what goes to your server with every session request |

Sessions, device data, sign-ins and completed purchases are reported by **your server** (the
device is refused for them). Sample: **Quick start**. The full guide, including a SmartFox backend, is
on the developer wiki (SDKs → Unity SDK).
