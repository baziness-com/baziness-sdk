# @baziness/server

Baziness for your game **server** (Node 18+). It keeps the client secret, gives your players'
devices their tokens and link codes, gives Gita coins, reports purchases and sends trusted
analytics (sessions, device data, sign-ins, game events). It stores no player token: the client
secret gets any of your players' tokens whenever one is needed (cached in memory).

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

## The player's install campaign

```ts
// When the player opens the game: the device as your server saw it.
const campaign = await baziness.players.campaign(userId, {
  ip: req.ip,                         // the player's IP (with a proxy in front: the forwarded one)
  userAgent: req.get('user-agent'),
  deviceModel: device.model,          // from the device SDK's DeviceInfo
  osVersion: device.osVersion,
});
// { status: 'attributed', matchType: 'probabilistic', utmSource: 'instagram', campaignCode: 'autumn', … }
```

An install that came with no campaign (no campaign link, UTMs, store referrer or APK campaign) is
`pending` for 24 hours after its first open. Asking with the device's fingerprint during that time
matches it to the campaign link click it most likely followed: `matchType: 'probabilistic'`. A
link, referrer or APK campaign is `deterministic` and always wins. Once `status` is no longer
`pending` the answer is final. The web and Unity SDKs can also ask from the device itself
(`campaign.get()`, `BazinessSdk.GetCampaignAsync()`).

## Baziness Pay

Baziness Pay is the web checkout (`pay.baziness.com`) for packages registered in Pay under your app's
package name. The device opens the checkout and, when the player taps "Complete purchase", finds the
paid payment and sends its token to your server:

```ts
const pay = baziness.pay('com.example.game');       // your app in Baziness Pay (Pay's pname)
if (await pay.verify(playerId, sku, token)) {        // your player id; the token must be this payment's
  await grantOnce(playerId, sku, token);             // your own grant, once per token
  await pay.consume(playerId, sku);                  // the player can buy it again
}
const payment = await pay.find(playerId, sku);       // or null: complete it without a device token
```

Report each payment you granted like any other purchase: `purchases.record` with gateway `baziness_pay`
and the payment's token as the order id (provider: `payment.gateway`, when you have it). `BAZINESS_PAY_BASE_URL`
(or `payBaseUrl`) overrides the environment's Pay address.

`npm test` runs 43 tests against the shared fake platform in `../tools/fake-hub`.
