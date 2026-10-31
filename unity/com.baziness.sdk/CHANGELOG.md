# Changelog

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
