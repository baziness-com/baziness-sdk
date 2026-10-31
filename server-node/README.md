# @baziness/server

Baziness for your game **server** (Node 18+). It keeps the client secret, gives your players'
devices 15-minute tokens and link codes, gives Gita coins, reports purchases and sends trusted
analytics (sessions, device data, sign-ins, game events). It stores no player token: the client
secret gets a new access token for any of your players whenever one is needed.

## Install

```bash
npm install @baziness/server
```

## Quick start

```ts
import { BazinessServer } from '@baziness/server';

const baziness = BazinessServer.fromEnv(process.env, { logger: console });
// BAZINESS_ENVIRONMENT=staging|production, BAZINESS_CLIENT_ID, BAZINESS_CLIENT_SECRET

const session = await baziness.players.signIn({ deviceId, platform: 'Web', store: 'Direct', userId, linkCode });
const { code } = await baziness.players.linkCode(session.userId);       // open a Baziness page
await baziness.coins.add({ userId: session.userId, amount: 50, grantKey: `match:${matchId}` });
await baziness.purchases.record({ userId, amount: 49000, gateway: 'cafebazaar', orderId, sku });
baziness.analytics.sessions.start(userId, { device });                   // on connect
baziness.analytics.levelComplete(userId, { level: 7, score: 1200 });     // one method per event
baziness.analytics.sessions.end(userId);                                 // on disconnect
const bazinessUserId = await baziness.players.findByPhone('09121234567'); // or null
const bundleId = await baziness.offers.get(playerId);                    // your player id; or null
await baziness.close();                                                   // on shutdown
```

`npm test` runs 33 tests against the shared fake platform in `../tools/fake-hub`.
