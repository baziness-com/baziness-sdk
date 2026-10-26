# Changelog

All notable changes to the Baziness SDKs will be documented in this file.

The project follows [Semantic Versioning](https://semver.org/).

## [Unreleased]

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

[Unreleased]: https://github.com/baziness-com/baziness-sdk/compare/v1.1.0...HEAD
[1.1.0]: https://github.com/baziness-com/baziness-sdk/compare/v1.0.1...v1.1.0
[1.0.1]: https://github.com/baziness-com/baziness-sdk/compare/v1.0.0...v1.0.1
[1.0.0]: https://github.com/baziness-com/baziness-sdk/releases/tag/v1.0.0
