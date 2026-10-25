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
   │      (your own routes)           │── client/auth, v2/client/create-user ──► id
   │                                  │── auth/refresh (refresh token kept here)
   │◄── 15-min access token ──────────│── v2/client/link-code ─────────────────► pages
   │── user/get-coin, events/batch ─────────────────────────────────────────────► hub
   │── open page ?linkCode= ────────────────────────────────────────────────────► baziness.com
                                      │── add-coin, record-purchase, server-events ► hub
```

- The **server SDK** owns everything secret or trusted: the client secret, refresh tokens, coin
  grants, purchases, and the trusted analytics channel (`analytics/server-events/batch`), which is the
  only place Baziness accepts sessions, device data, sign-ins and purchase completions from.
- The **device SDKs** never hold a secret. They ask the game's own server (four routes: `/session`,
  `/link-code`, `/login`, `/logout`) and talk to Baziness only with the player's 15-minute token:
  coin balance, player analytics, Baziness pages.
- **One account across games**: pages are opened with one-time link codes; opening another game
  from a page hands over a link code, and the next game's `players.signIn({ linkCode })` joins the
  same Baziness person.

## Tests

Every SDK is tested against one shared fake of the platform API, [tools/fake-hub](tools/fake-hub)
(Node, in-memory: refresh-token rotation, link codes joining persons, coin idempotency, server-only
event names, injected failures). Needs Node 18+.

```bash
./scripts/test-all.sh                                 # all four SDKs
cd server-node && npm ci && npm test                 # 28 tests
cd server-java && ./build.sh                          # 12 tests, Java 8 jar in out/
cd web && npm ci && npm test && npm run build         # 9 tests, dist/ + dist/baziness.global.js
cd unity/tests/Baziness.Core.Tests && ./run-tests.sh  # 8 tests of the engine-free core (C# 9)
```

The Unity package itself is compiled by opening any Unity 2021.3+ project that references it
(`"com.baziness.sdk": "file:<path>"` in `Packages/manifest.json`); it was compiled in Unity
6000.3.21f1 with both samples and gree's `WebViewObject` (0 errors, 0 SDK warnings).

Cross-SDK parity: `transactionIdFor(239236, 50, "match:17")` = `239236_50_dc3ee6230b3a94ce5764afe9`
and `stableEventId("purchase:cafebazaar:order-1")` = `78b6c864-1376-5500-8720-9e4a2e0f87a2` in Node and
Java (asserted in both test suites).

## Releasing

See [RELEASING.md](RELEASING.md) for registry bootstrap, signing, and the automated tag workflow.

| Package | Where | How |
| --- | --- | --- |
| `@baziness/server`, `@baziness/web` | npm | push a matching `vX.Y.Z` tag; CI publishes with npm OIDC |
| `baziness-server-<version>.jar` | GitHub Releases | bump `SDK_VERSION` in `BazinessServer.java`; CI builds the dependency-free Java 8 JAR |
| `com.baziness.sdk` | GitHub tag | use `https://github.com/baziness-com/baziness-sdk.git?path=/unity/com.baziness.sdk#v1.0.1` |

Keep all five version declarations equal. `./scripts/check-versions.mjs` verifies them locally and in CI.

## Security and contributing

See [SECURITY.md](SECURITY.md) for private vulnerability reporting and
[CONTRIBUTING.md](CONTRIBUTING.md) for development and pull-request guidance.

Licensed under the [Apache License 2.0](LICENSE).
