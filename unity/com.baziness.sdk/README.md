# Baziness SDK for Unity (`com.baziness.sdk`)

Baziness for the **player's device** in a Unity game (2021.3+): Baziness pages in a web view, the
Gita coin balance, sign-in hand-over from other games (link codes in deep links), install
attribution, device info and player analytics. It holds no secret: sessions and link codes come from
your game server, which uses the Baziness server SDK (Node or Java).

## Install

In Package Manager, choose **Add package from git URL**, then enter:

`https://github.com/baziness-com/baziness-sdk.git?path=/unity/com.baziness.sdk#v1.1.0`

## Quick start

```csharp
BazinessSdk.Initialize(settings, new HttpGameBackend(new UnityHttp(), settings.gameServerUrl, AuthHeaders),
    GreeWebViewPageView.Create());            // from the "gree unity-webview page view" sample
var session = await BazinessSdk.StartAsync();
BazinessSdk.PageClosed += _ => RefreshBalance();
await BazinessSdk.OpenPage(BazinessPage.Shop);
long balance = await BazinessSdk.GetCoinBalanceAsync();
BazinessSdk.Analytics.LevelComplete("7", 1200);   // one method per event
```

Samples (Package Manager → Samples): **Quick start**, **gree unity-webview page view**.
