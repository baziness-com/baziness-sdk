# Changelog

All notable changes to the Baziness SDKs will be documented in this file.

The project follows [Semantic Versioning](https://semver.org/).

## [Unreleased]

- Unity docs: `ReportTrackerDevice` takes AppMetrica's `DeviceIdHash` (`StartupParamsKey.AppMetricaDeviceIDHash`), the
  `appmetrica_device_id` of its exports; the 2.5.0 example used `DeviceId`, which never matches.

## [2.5.0] - 2026-11-11

- **Unity: `BazinessSdk.ReportTrackerDevice(tracker, deviceId)`**: tell Baziness the id an attribution
  tracker gave the device (AppMetrica device id). AppMetrica never tells the app which campaign an install
  came from, so Baziness reads it from AppMetrica's own records and matches it by this id; this is what
  attributes Google Ads installs, APK installs and tracking links without a deep link. Callable before or
  after `Initialize`, on any thread; sent once per player as the event `baziness:tracker:device`
  (props `tracker`, `device_id`). Keep calling `ReportTrackerAttribution` too.
- No change in the other SDKs: they share one version.

## [2.4.0] - 2026-11-08

- Server SDKs (Java, Node, .NET): `ads` fetches the game's sponsor ad and reports explicit `seen`
  and `click` events with the Baziness user id. Uses the SDK's shared client authentication,
  timeouts and retry policy; tracking is not retried after an uncertain outcome. No old platform
  library or separate HTTP/auth implementation is needed.
- Unity and Web share the release version; no device API change. Ad administration and trusted
  impression/click tracking are server operations.


## [2.3.0] - 2026-11-04

- **Unity: the page reaches the sheet's top, under the handle, like the web SDK's**: the handle strip
  (`handleStripHeight`, `handleSize`, `handleColor`) now lies over the top of the page, which shows under
  it, where it used to be an empty strip above the page; the page's corners round like the sheet's
  (`cornerRadius`). Tapping the handle closes the page; dragged, the sheet follows the finger on Android
  (elsewhere the page's content follows) and closes past `dragToClose` or springs back.
- No change in the other SDKs: they share one version.

## [2.2.0] - 2026-11-04

- **Web: the page sheet from Fal, for every web game**: the sheet slides up at once with the Baziness logo and a
  spinner (`loaderIcon`, `spinnerColor`, `loaderBackground`) and shows the page when its link code is ready and
  loaded, where `openPage` used to wait for the link code before showing anything. A handle strip over the top
  of the page (a button: `closeLabel`) closes it when tapped; dragged, the sheet follows 1:1 and the shade
  lightens with it, closing past a quarter of the sheet (160 px at most) or springing back. The shade's blur
  radius is fixed and only its opacity animates, which keeps weak phones smooth; reduced motion is respected.
  New defaults: 22 px gap above (`topGap` also takes pixels), 480 px wide (`maxWidth`), 20 px corners, 14 px
  blur (`blurPx`), Baziness purple. The fallback close button is off unless `closeButtonAfterMs` is set.
- Web: a page's shared text that falls back to the clipboard emits `copied`; cancelling the share sheet no
  longer copies the text.
- No change in the other SDKs: they share one version.

## [2.1.1] - 2026-11-03

- **Web: pages open on a sheet with a handle, like Unity's**: the game stays in view above the sheet, blurred
  and shaded (`topGap`, `shade`, `blurGame`), where it used to stop 12 px short of the top with no handle. A handle
  tops the sheet: tapping it or the game closes the page, as does dragging it down, with a mouse or a finger
  (dragged a little, it springs back: `dragToClose`). `handleStripHeight`, `handleSize`, `handleColor`,
  `cornerRadius` and `backdrop` style it, all under the `overlay` option. It is at most 560 px wide (was 640).
- No change in the other SDKs: they share one version.

## [2.1.0] - 2026-11-03

- **.NET server SDK**: `Baziness.Server` on NuGet (.NET 8 or newer, no dependencies), with the same API and
  behaviour as `@baziness/server` and `baziness-server`: players, link codes, coins, purchases, Baziness
  Pay, sessions and trusted analytics, quests and offers. It runs against the same fake platform as the
  others. Its release artifact is `baziness-sdk-dotnet-<version>.nupkg`.
- **`players.signIn` sees an account linked or blocked since** (Node, Java): for a known player it answered
  from the SDK's memory, and since 2.0.0 tokens live for years, so `isLinkedToAccount` stayed `false` after
  a player linked on a page, and a blocked account went unnoticed, until the server restarted. It now asks
  the platform; `players.session` still answers from memory.
- `SDK_VERSION` of `@baziness/server` still said 1.5.0; it and the web SDK's are now checked with the others.

## [2.0.0] - 2026-11-03

Players get **long-lived tokens** again; there are no refresh tokens and no 15-minute access tokens
for game servers any more. The platform withdrew `v2/client/create-user`, `v2/client/access-token`,
`v2/client/get-user-token`, `auth/refresh` and `auth/logout`, so **every earlier SDK version stops
signing players in**: update to 2.0.0 before the platform release.

- Server SDKs: `players.signIn` / `players.session` use `client/create-user` and
  `client/get-user-token/{id}` and keep each player's token in memory. `PlayerSession` keeps its shape:
  `accessToken` is the player's token, `accessTokenExpiresAt` its own expiry (years away).
- Link codes are unchanged: `players.linkCode` for Baziness pages, `linkCode` in `signIn` to join
  the person who arrived with one. A page opened with a link code still acts as your player with a
  short-lived token of its own; only the page holds it.
- Removed: the `refreshTokens` option and `RefreshTokenStore` / `MemoryRefreshTokenStore`, and the
  low-level `accessToken`, `newSession`, `refresh` and `revoke` (Node, Java). Low-level calls are now
  `players.create(...)` and `players.token(userId)`. Refresh-token error codes are gone
  (`ErrorCodes.refreshToken*`, `BazinessException.REFRESH_TOKEN_ROTATED`); `SignInMethod` no longer
  lists `new_session`.
- Device SDKs (web, Unity): no API change. Your server's session route answers what `players.signIn`
  returns; with a long-lived token the device renews only on a 401.
- Fake hub: long-lived player tokens from `client/create-user` and `client/get-user-token`.

## [1.7.1] - 2026-11-02

- **Unity: pages open on a sheet, like the web SDK's**: the game stays in view above it, blurred and
  shaded (`topGap`, `shade`, `blurGame`); a handle tops the sheet, and tapping it or the game closes the
  page, as does dragging it down (dragged a little, it springs back: `dragToClose`). `handleStripHeight`,
  `handleSize`, `handleColor` and `cornerRadius` style it; `closeButtonPosition` is now from the sheet's
  top-right corner.
- **Unity: a page that cannot load shows a retry button**, with the close button, instead of a blank web
  view that blocks the game: on a load error (Android reported its error page as loaded) and when the page
  has not loaded in `PageViewStyle.loadTimeoutSeconds` (20 s). `retryIcon` and `retryButtonSize` style it.

## [1.7.0] - 2026-11-02

- **Unity: `BazinessSdk.ReportTrackerAttribution(tracker, …)`**, one call for every attribution SDK's answer
  (Metrix, AppMetrica, Adjust, …): pass what the tracker reported, as a dictionary (UTMs, AppMetrica's deferred
  deep link parameters with a Baziness link's `bz_lc` / `bz_click`, or the tracker's own names such as
  `source`, `campaign`, `adset`, `ad`) or as `source, campaign, adSet, ad`. It can be called before
  `Initialize` and from the tracker's own thread. The install keeps its first campaign; empty and organic
  answers are skipped; each answer is also recorded as the event `baziness:attribution:tracker`.
- **Unity: a campaign that arrives while the first session request is on its way is no longer lost**:
  `SetInstallReferrer`, `SetCampaignAttribution` and tracker answers wait for that session and send it
  straight after.

## [1.6.0] - 2026-11-02

- **Report Baziness Pay payments too**: Baziness counts what game servers report, so the server SDKs'
  `purchases.record` accepts gateway `baziness_pay` (order id = the payment's token, provider = its bank
  when you have it). Pay's own record no longer counts as the game's revenue. Java `Purchases`, Node
  `PaymentGateway` (`FunnelGateway` is now the same type), docs.
- **The checkout no longer carries the player's Baziness token** (`bztoken`): Pay doesn't need to know the
  Baziness user any more. Unity `BazinessPay` and web `BazinessPay` constructors lose their token parameter
  (`BazinessSdk.Pay` / `baziness.pay` are unchanged); `CheckoutUrl` / `checkoutUrl` keep their signatures.

## [1.5.0] - 2026-11-01

- **Baziness Pay** in every SDK, for packages registered in Pay (the web checkout, `pay.baziness.com`).
  The device no longer waits for the game to come back to the foreground: the game shows a "complete
  the purchase" dialog, opens the checkout, and finds the payment when the player taps it.
  - Unity: `BazinessSdk.OpenCheckoutAsync(sku, playerId)` opens the checkout in the browser with the
    player's Baziness token (`bztoken`, so the payment counts for the player's account);
    `BazinessSdk.FindPaymentAsync(sku, playerId)` returns the paid, unconsumed payment or null.
    `BazinessSdk.Pay` (`BazinessPay`, engine-free core), `BazinessUrls.Pay`, and
    `BazinessOptions.PayBaseUrlOverride` / `PayPackageName` (settings: `payBaseUrlOverride`).
  - Web: `baziness.pay.openCheckout` (opens the tab in the tap, then navigates), `checkoutUrl`,
    `findPayment`; options `payBaseUrl`, `payPackageName`.
  - Server SDKs: `pay(packageName)` with `find`, `verify` and `consume`. `verify` accepts only the token of
    the paid payment (Pay alone accepts any token while one is paid) and, when none is paid yet, lets
    Pay check the token with the bank. A `consume` whose answer was lost counts as consumed. Options
    `payBaseUrl` / `BAZINESS_PAY_BASE_URL`; Node's `publicConfig().payUrl` follows the override.
- Java: Pay calls are streamed like client-token calls, so the JDK cannot resend one unseen.
- Fake hub: a Baziness Pay under `/pay` (`/__control/pay-payment`, `/__control/drop-after-consume`).

## [1.4.0] - 2026-11-01

Install campaigns, with fingerprint attribution. An install that came with no campaign (no campaign
link, UTMs, store referrer or APK campaign) is `pending` for 24 hours after its first open; asking
for its campaign during that time lets Baziness match it by the device's fingerprint (IP and
User-Agent, plus model and OS version) to the campaign link click it most likely followed. Such a
campaign has `matchType: 'probabilistic'`; a link, referrer or APK campaign is `deterministic` and
always wins. Once the campaign is no longer pending, the answer is final.

- Server SDKs (Node, Java): `players.campaign(userId, device)` with the device as your server saw it
  (`DeviceFingerprint`: `ip`, `userAgent`, `deviceModel`, `osVersion`); `POST v2/client/attribution/{id}`.
  403 for another game's player.
- Web: `campaign.get()` asks from the device itself (`POST analytics/attribution/resolve` with the
  player's token). `start()` first reads the device's real model and Android version from Chrome's
  client hints (`refineDevice`), so they also reach your server in `SessionRequest.device`; the
  reduced User-Agent's frozen "Android 10" is no longer reported as the OS version.
- Unity: `BazinessSdk.GetCampaignAsync()` (`InstallCampaign`, `Campaign`), asked from the device; a late
  `SetInstallReferrer` / `SetCampaignAttribution` report carries the device model and OS version, so
  one without a campaign can still be matched.
- Fake hub: `POST /__control/click` registers a campaign link click; the two campaign routes match
  an install with no campaign to the latest click from its IP; `state.fingerprints` lists what each
  lookup saw.

## [1.3.0] - 2026-10-31

- Unity: the page view appears **the moment a page is asked for**. `BazinessWebView` slides up with its
  spinner and starts the web view while your server makes the link code, then loads the page when the
  code arrives; before, nothing showed until the code was back. A page view that can do this implements
  the new `IInstantPageView` (`ShowLoading`); other `IPageView`s open as before. Closing the page during
  the wait cancels it, and a failed link code closes it again.
- Unity: smoother slides: the page view eases out as it opens (0.3 s) and eases in as it closes
  (0.25 s, the whole page moving down). `PageViewStyle.openSeconds` and `closeSeconds` are the new
  defaults; 1.2 took 0.45 s and 0.4 s, and its close covered most of the way in the first frames.
- Server SDKs and web: no change; the version follows the Unity package.

## [1.2.1] - 2026-10-31

- Server SDKs (Node, Java): `coins.add` no longer reports a refused payout as paid. The platform answers
  every refusal with the same `add resource failed` (the game's coin wallet short of coins, or the id
  already paid). 1.2.0 read it as `alreadyCredited`, so a game could show coins the player never got. Now
  `alreadyCredited` comes only when this call had sent the payout before without an answer (timeout,
  500, dropped connection) and the platform refused the resend; any other refusal throws
  `add_coin_refused` (`ErrorCodes.addCoinRefused`, `BazinessException.ADD_COIN_REFUSED`). Calling `add`
  again for a payout that was already paid therefore throws instead of returning `alreadyCredited`.
- Java: client-token requests are streamed, so the JDK can no longer resend a POST on its own when the
  connection drops before the answer (unseen by the SDK's retries: a second user, a payout reported as
  refused).
- Unity: `BazinessSdk.IsPageOpen`, to skip the game's own back-button handling while a page is up (the
  page view closes on the same key press).
- Fake hub: a client coin wallet (`/__control/client-wallet`) and a payout whose answer is lost
  (`/__control/drop-after-credit`).

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

[Unreleased]: https://github.com/baziness-com/baziness-sdk/compare/v1.3.0...HEAD
[1.3.0]: https://github.com/baziness-com/baziness-sdk/compare/v1.2.1...v1.3.0
[1.2.1]: https://github.com/baziness-com/baziness-sdk/compare/v1.2.0...v1.2.1
[1.2.0]: https://github.com/baziness-com/baziness-sdk/compare/v1.1.0...v1.2.0
[1.1.0]: https://github.com/baziness-com/baziness-sdk/compare/v1.0.1...v1.1.0
[1.0.1]: https://github.com/baziness-com/baziness-sdk/compare/v1.0.0...v1.0.1
[1.0.0]: https://github.com/baziness-com/baziness-sdk/releases/tag/v1.0.0
