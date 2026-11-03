# Changelog

## 2.1.1 — 2026-11-03

- No change in this package: the SDKs share one version, and 2.1.1 changes the web SDK's page sheet.

## 2.1.0 — 2026-11-03

- No change in this package: the SDKs share one version, and 2.1.0 adds the .NET server SDK.

## 2.0.0 — 2026-11-03

- No API change. Players' tokens from your server are long-lived again (the platform withdrew
  refresh tokens and 15-minute access tokens), so the session renews only when a call answers 401.
  Update your server SDK to 2.0.0 as well: earlier versions can no longer sign players in.

## 1.5.0 — 2026-11-01

- Baziness Pay, the web checkout: `BazinessSdk.OpenCheckoutAsync(sku, playerId)` opens the checkout page
  with the player's Baziness token; `BazinessSdk.FindPaymentAsync(sku, playerId)` returns the paid,
  unconsumed payment (or null) when the player taps your "Complete purchase" button. Send its `Token`
  to your server (server SDK: `pay.verify`, then `pay.consume`). `BazinessSdk.Pay`, `BazinessUrls.Pay`,
  options `PayBaseUrlOverride` / `PayPackageName` (settings: `payBaseUrlOverride`).

## 1.4.0 — 2026-11-01

- `BazinessSdk.GetCampaignAsync()`: the install's campaign (`Campaign`), asked from the device. One that
  came with no campaign is pending for 24 h after first open and is matched by this device's
  fingerprint to a recent campaign link click (`matchType` `probabilistic`).
- A late `SetInstallReferrer` / `SetCampaignAttribution` report carries the device model and OS version,
  so one without a campaign can still be matched.

## 1.3.0 — 2026-10-31

- The page view appears at once and starts the web view while your server makes the link code
  (`IInstantPageView.ShowLoading`; the built-in `BazinessWebView` implements it).
- Smoother slides: ease-out open in 0.3 s, ease-in close in 0.25 s (`PageViewStyle` defaults).

## 1.2.1 — 2026-10-31

- `BazinessSdk.IsPageOpen`: skip your own back-button handling while a page is up.

## 1.2.0 — 2026-10-31

- Safe-area insets go to pages in percent of the screen height (1.1.0 sent pixels).
- `SetCampaignAttribution` for the campaign an attribution SDK reports; `GetReferralRewardCountAsync`.
- The web view is built in: gree unity-webview is bundled and `BazinessWebView` (backdrop, spinner, close
  button, slide animations; `PageViewStyle`) is the default page view. Remove your own copy of gree.
  The gree sample is removed.
- `BackendSession.FromDictionary` reads `long` / `int` values (an `IGameBackend` over SmartFox).

## 1.1.0 — 2026-10-26

One analytics method per event (`BazinessSdk.Analytics.LevelComplete(…)`, …); sessions come from
your game server, which keeps no player token.

## 1.0.1 — 2026-10-25

Release automation validation; SDK behavior is unchanged from 1.0.0.

## 1.0.0 — 2026-10-25

First release: `BazinessSdk` (pages with one-time link codes, coin balance, session through your
game server, deep-link sign-in hand-over, first-touch attribution and install referrer, device info,
persisted player analytics), `HttpGameBackend`, `UnityHttp`, `IPageView` with the gree sample.
