# Changelog

All notable changes to the Baziness SDKs will be documented in this file.

The project follows [Semantic Versioning](https://semver.org/).

## [Unreleased]

## [1.2.0] - 2026-10-31

- Unity: safe-area insets (`top`, `bot`) go to Baziness pages in **percent of the screen height**,
  as the pages apply them (`vh`). 1.1.0 sent pixels, which pushed page content off screen on phones
  with a notch. `PageUrl.InsetPercent` converts.
- Unity: `BazinessSdk.SetCampaignAttribution(utmSource, …)` for the campaign an attribution SDK
  (Metrix, Adjust, AppsFlyer) reports after the first open; first touch wins. It shares the late
  attribution path with `SetInstallReferrer`.
- Unity, web: the referral reward count for a badge on the game's referral button
  (`BazinessSdk.GetReferralRewardCountAsync()`, `baziness.referrals.collectable()`).
- Unity: **the web view is built in.** The package bundles gree unity-webview (zlib; `Runtime/WebView`:
  `WebViewObject`, the Android library, the iOS WKWebView source, the macOS bundle) and
  `BazinessWebView`, the default page view: a backdrop that slides up, a spinner while the page loads, a
  close button when it loads slowly, a slide-down on close and the Android back button (Yatzy's look,
  changeable with `PageViewStyle` in `BazinessOptions` or the settings asset). Windows, Linux and WebGL
  still open pages in the system browser. The "gree unity-webview page view" sample is removed. Projects
  must delete their own copy of gree unity-webview (`Assets/Plugins/WebViewObject.cs`, the plugins and
  `UnityWebViewPostprocessBuild.cs`): `WebViewObject` keeps its name, so code using it compiles as before.
  `Editor/WebViewBuildProcessor.cs` (from gree's build script) keeps the AndroidX, FileProvider,
  hardware-acceleration and WebKit settings; the Android library is a normal plugin, so nothing is copied
  into `Assets` at build time. The package now depends on `com.unity.ugui`.
- Unity: `BackendSession.FromDictionary` reads whole numbers given as `long` or `int` too, so an
  `IGameBackend` over a socket (SmartFox) can pass its values as they are; 1.1.0 read them as 0.
- Server SDKs (Node, Java): `players.findByPhone(phoneNumber)` (your player who signed in with that
  phone number) and `offers.get(playerId)` (the bundle the Baziness offer engine picks for a player).
- Fake hub: `client/check-phone-number`, `client/get-user-offer`,
  `user/referral-collectable-accounts-count`.

## [1.1.0] - 2026-10-26

- Server SDKs (Node, Java): game servers keep no player token. `players.signIn` creates players with
  `v2/client/create-user` (`accessTokenOnly`) and renews with `v2/client/access-token/{userId}`: the
  client secret is enough, so there is no refresh token to store, rotate or leak. The
  `refreshTokens` option is no longer needed; a store passed by a 1.0 integration is only used by
  `players.logout`, which ends the sessions left in it. Needs the platform release with
  `v2/client/access-token`.
- Analytics: one method per event Baziness analytics knows instead of a free-form `track(name)`:
  `purchaseStarted`, `purchaseFailed`, `adImpression`, `adRevenue`, `tutorialBegin`,
  `tutorialComplete`, `levelStart`, `levelComplete`, `levelFail`, `resourceEarn`, `resourceSpend`
  (Unity: `BazinessSdk.Analytics.LevelComplete(…)`, …). The free-form `track` is removed from the
  public API of every SDK; the SDKs' own events (sessions, sign-ins, purchases, Baziness pages) are
  unchanged.
- Fake hub: `v2/client/access-token`, `accessTokenOnly`, and it starts on Windows too.
- Give every GitHub Release artifact a consistent `baziness-sdk-{platform}` filename.

## [1.0.1] - 2026-10-25

- Validate tokenless npm publishing from GitHub Actions and GitHub-hosted Java/Unity artifacts.

## [1.0.0] - 2026-10-25

- Initial public SDK release for Node.js game servers, Java game servers, web games, and Unity games.

[Unreleased]: https://github.com/baziness-com/baziness-sdk/compare/v1.2.0...HEAD
[1.2.0]: https://github.com/baziness-com/baziness-sdk/compare/v1.1.0...v1.2.0
[1.1.0]: https://github.com/baziness-com/baziness-sdk/compare/v1.0.1...v1.1.0
[1.0.1]: https://github.com/baziness-com/baziness-sdk/compare/v1.0.0...v1.0.1
[1.0.0]: https://github.com/baziness-com/baziness-sdk/releases/tag/v1.0.0
