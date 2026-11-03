# Baziness SDK for Unity (`com.baziness.sdk`)

Baziness for the **player's device** in a Unity game (2021.3+): Baziness pages in a built-in web view,
the Gita coin balance, sign-in hand-over from other games (link codes in deep links), install
attribution, device info and player analytics. It holds no secret: sessions and link codes come from
your game server, which uses the Baziness server SDK (Node or Java).

## Install

Package Manager → **Add package from git URL**:

`https://github.com/baziness-com/baziness-sdk.git?path=/unity/com.baziness.sdk#v2.1.0`

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

## Baziness Pay

Packages registered in Baziness Pay are paid on its web checkout, in the browser. Don't wait for the
game to come back to the foreground: show a dialog that asks the player to tap "Complete purchase"
once they have paid, and open the checkout:

```csharp
ShowCompletePurchaseDialog(onComplete: CompletePurchase);
await BazinessSdk.OpenCheckoutAsync(sku, playerId);       // your player id; with the player's Baziness token

async void CompletePurchase()
{
    var payment = await BazinessSdk.FindPaymentAsync(sku, playerId);
    if (payment == null) ShowNotPaidYet();                // keep the dialog: they can tap again
    else MyServer.CompletePurchase(sku, payment.Token);   // server SDK: pay.verify, grant once, pay.consume
}
```

`BazinessOptions.PayBaseUrlOverride` and `PayPackageName` (default: `PackageName`) override the Pay
address and app name. Pay reports these payments to Baziness itself.

## The page view

`BazinessWebView` shows a page on a sheet over the game. It appears the moment `OpenPage` is called: the
sheet slides up, the game stays in view above it (blurred and shaded), and a spinner turns while your
server makes the link code and the page loads. A handle tops the sheet: tapping it or the game closes the
page, and so does dragging it down. A close button appears when the page takes longer than three seconds,
a retry button when it cannot load, and the Android back button closes it. Change its look with
`PageViewStyle` (sheet and shade colours, the gap above the sheet, handle, corners, spinner, close and retry
sprites, sizes, positions, timings, canvas sorting order) in the settings asset or in
`BazinessOptions.PageViewStyle`; the defaults are Yatzy's. To show pages your own way, pass an
`IPageView` (`SdkType`, `IsOpen`, `Open`, `Close`) as `BazinessOptions.PageView`; implement
`IInstantPageView` (`ShowLoading`) too for it to appear before the link code arrives.

## API

| | |
| --- | --- |
| `Initialize`, `StartAsync`, `RefreshSessionAsync` | session from your server; call `RefreshSessionAsync` after your own login changed the player or the connection to your server was re-established |
| `Session`, `IsLinkedToAccount`, `SessionChanged` | the current session (null after logout); linked = signed in with a phone number |
| `OpenPage(BazinessPage.Login / Profile / Shop / GameOffer / Referral)`, `ClosePage` | pages with a fresh link code, safe-area insets, store and platform |
| `IsPageOpen`, `PageOpened`, `PageClosed`, `LoggedIn`, `LoggedOut`, `ShareRequested` | page state and events (`LoggedIn` carries your server's `/login` answer); skip your own back-button handling while `IsPageOpen` |
| `GetCoinBalanceAsync`, `GetReferralRewardCountAsync` | read with the player's token |
| `GetCampaignAsync` | the install's campaign; one still pending (24 h after first open, no campaign) is matched by this device's fingerprint to a recent campaign link click (`matchType` `probabilistic`) |
| `OpenCheckoutAsync`, `FindPaymentAsync`, `Pay` | Baziness Pay: open the checkout page, find the payment when the player says they paid |
| `Analytics.PurchaseStarted / PurchaseFailed / AdImpression / AdRevenue / TutorialBegin / TutorialComplete / LevelStart / LevelComplete / LevelFail / ResourceEarn / ResourceSpend` | player analytics, queued in a file and sent in batches |
| `ReportTrackerAttribution` | call it from every attribution SDK's callback (Metrix, AppMetrica, …) with what it reported, before or after `Initialize`, on any thread; the first campaign is kept, organic answers skipped |
| `HandleDeepLink` (automatic), `SetInstallReferrer`, `SetCampaignAttribution` | first-touch attribution: deep-link `utm_*` / `bz_lc` / `bz_click`, store referrer, the campaign your attribution SDK reports |
| `Device`, `Attribution` | what goes to your server with every session request |

Sessions, device data, sign-ins and completed purchases are reported by **your server** (the
device is refused for them). Sample: **Quick start**. The full guide, including a SmartFox backend, is
on the developer wiki (SDKs → Unity SDK).
