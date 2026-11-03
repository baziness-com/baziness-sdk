# Baziness SDKs

[![CI](https://github.com/baziness-com/baziness-sdk/actions/workflows/ci.yml/badge.svg)](https://github.com/baziness-com/baziness-sdk/actions/workflows/ci.yml)
[![License](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)

Everything a partner game needs to join Baziness: one account across games, Gita coins, Baziness
pages, purchases and growth analytics. Each package directory contains its setup and API guide.
This document explains how the SDKs fit together and how maintainers test and release them.

| Package | For | Language | Folder |
| --- | --- | --- | --- |
| `@baziness/server` | the game **server** ("client" in Baziness terms) | TypeScript / Node 18+ | [server-node](server-node) |
| `baziness-server` (`com.baziness.server`) | the game **server** (SmartFox, Spring, …) | Java 8+, no dependencies | [server-java](server-java) |
| `@baziness/web` | the **device** of a web game | TypeScript, ESM + script tag | [web](web) |
| `com.baziness.sdk` | the **device** of a Unity game | C# (Unity 2021.3+) | [unity/com.baziness.sdk](unity/com.baziness.sdk) |

## How the pieces fit

```
 player device                      game server                         Baziness
 ─────────────                      ───────────                         ────────
 @baziness/web | com.baziness.sdk   @baziness/server | baziness-server
   │ session / link-code / login ──►  │ client id + secret (secret never leaves)
   │      (your own routes)           │── client/auth, client/create-user ─────► id
   │                                  │── client/get-user-token (kept in memory only)
   │◄── player token ─────────────────│── v2/client/link-code ─────────────────► pages
   │── user/get-coin, events/batch, analytics/attribution/resolve ───────────────► hub
   │── open page ?linkCode= ────────────────────────────────────────────────────► baziness.com
   │── open checkout /buy?…, get_payment ───────────────────────────────────────► Baziness Pay
                                      │── add-coin, record-purchase, server-events ► hub
                                      │── v2/client/attribution (the install's campaign) ► hub
                                      │── get_payment, verify_payment, consume ──► Baziness Pay
```

- The **server SDK** owns everything secret or trusted: the client secret, coin grants, purchases,
  and the trusted analytics channel (`analytics/server-events/batch`), which is the only place
  Baziness accepts sessions, device data, sign-ins and purchase completions from. It stores no player
  token: the client secret gets any of its players' (long-lived) tokens whenever needed.
- The **device SDKs** never hold a secret. They ask the game's own server (four routes: `/session`,
  `/link-code`, `/login`, `/logout`) and talk to Baziness only with the player's token:
  coin balance, player analytics, Baziness pages.
- **Analytics** has one method per event Baziness knows (the purchase funnel, ads, onboarding,
  levels, in-game currency), on the device SDKs and the server SDKs alike; there is no free-form
  event name.
- **Install campaigns**: `players.campaign` (server, with the device it saw), `campaign.get()` (web)
  and `BazinessSdk.GetCampaignAsync()` (Unity) answer the install's campaign. One still pending (no
  campaign link, UTMs, store referrer or APK campaign within 24 h of first open) is first matched by
  the device's fingerprint to a recent campaign link click (`matchType: 'probabilistic'`).
- **Baziness Pay** (the web checkout): the device SDKs open the checkout page with the player's token
  and, when the player taps "Complete purchase", find the paid payment; the server SDKs verify its token
  and consume it after the game granted it, then report it like any purchase (`baziness_pay`): Baziness
  counts what game servers report.
- **One account across games**: pages are opened with one-time link codes; opening another game
  from a page hands over a link code, and the next game's `players.signIn({ linkCode })` joins the
  same Baziness person.

## Tests

Every SDK is tested against one shared fake of the platform API, [tools/fake-hub](tools/fake-hub)
(Node, in-memory: player tokens, link codes joining persons, coin idempotency, server-only event
names, phone lookup, offers, referral rewards, campaign link clicks and fingerprint matching, Baziness Pay payments, injected failures). Needs Node 18+.

```bash
./scripts/test-all.sh                                 # all four SDKs
cd server-node && npm ci && npm test                 # 41 tests
cd server-java && ./build.sh                          # 17 tests, Java 8 jar in out/
cd web && npm ci && npm test && npm run build         # 13 tests, dist/ + dist/baziness.global.js
cd unity/tests/Baziness.Core.Tests && ./run-tests.sh  # 13 tests of the engine-free core (C# 9)
```

The Unity package itself is compiled by opening any Unity 2021.3+ project that references it
(`"com.baziness.sdk": "file:<path>"` in `Packages/manifest.json`); it was compiled in Unity
6000.3.21f1 with the Quick start sample (0 errors, 0 SDK warnings). The bundled web view (`Runtime/WebView`) is
gree unity-webview; see [Third Party Notices](unity/com.baziness.sdk/Third%20Party%20Notices.md).

Cross-SDK parity: `transactionIdFor(239236, 50, "match:17")` = `239236_50_dc3ee6230b3a94ce5764afe9`
and `stableEventId("purchase:cafebazaar:order-1")` = `78b6c864-1376-5500-8720-9e4a2e0f87a2` in Node and
Java (asserted in both test suites).

## Releasing

See [RELEASING.md](RELEASING.md) for registry bootstrap, signing, and the automated tag workflow.

| Package | Where | How |
| --- | --- | --- |
| `@baziness/server`, `@baziness/web` | npm | push a matching `vX.Y.Z` tag; CI publishes with npm OIDC |
| `baziness-sdk-js-server-<version>.tgz`, `baziness-sdk-js-web-<version>.tgz` | GitHub Releases | npm package archives built by CI |
| `baziness-sdk-java-<version>.jar` | GitHub Releases | bump `SDK_VERSION` in `BazinessServer.java`; CI builds the dependency-free Java 8 JAR |
| `baziness-sdk-unity-<version>.tgz` | GitHub Releases | Unity package archive built by CI |
| `com.baziness.sdk` | GitHub tag | use `https://github.com/baziness-com/baziness-sdk.git?path=/unity/com.baziness.sdk#v2.0.0` |

Keep all five version declarations equal. `./scripts/check-versions.mjs` verifies them locally and in CI.

## Security and contributing

See [SECURITY.md](SECURITY.md) for private vulnerability reporting and
[CONTRIBUTING.md](CONTRIBUTING.md) for development and pull-request guidance.

Licensed under the [Apache License 2.0](LICENSE).
