# baziness-server (Java)

Baziness for your game **server**, Java 8+, no dependencies — made for SmartFox extensions like
Yatzy's, and any other JVM server. Same API and behaviour as `@baziness/server`.

## Install

Download `baziness-sdk-java-2.0.0.jar` from the
[v2.0.0 GitHub release](https://github.com/baziness-com/baziness-sdk/releases/tag/v2.0.0) and add
it to your server's classpath. The JAR has no runtime dependencies and targets Java 8.

```bash
javac -cp baziness-sdk-java-2.0.0.jar YourGameServer.java
```

## Quick start

```java
// No player token to store: the client secret gets any player's token whenever one is needed.
BazinessServer baziness = BazinessServer.fromEnv(System.getenv()).build();

SignInResult session = baziness.players().signIn(
        new SignInRequest(deviceId, "Android", "CafeBazaar").userId(savedUserId).linkCode(linkCode));
Players.LinkCode code = baziness.players().linkCode(session.userId);
baziness.coins().add(session.userId, 50, "match:" + matchId, null);
baziness.analytics().sessions().start(session.userId, device);   // SmartFox USER_LOGIN
baziness.analytics().sessions().end(session.userId);             // USER_DISCONNECT / USER_LOGOUT
baziness.analytics().levelComplete(session.userId, "7", 1200.0, null);   // one method per event
long byPhone = baziness.players().findByPhone("09121234567");            // 0 when none of your players
Integer bundleId = baziness.offers().get(playerId);                       // your player id; null for none
baziness.close();                                                // extension destroy()
```

## The player's install campaign

```java
// When the player logs in: the device as your server saw it (SmartFox: the session's address).
Campaign campaign = baziness.players().campaign(userId,
        new DeviceFingerprint(user.getSession().getAddress(), userAgent).withDevice(device.model, device.osVersion));
// campaign.status "attributed", campaign.matchType "probabilistic", campaign.utmSource, campaign.campaignCode …
```

An install that came with no campaign (no campaign link, UTMs, store referrer or APK campaign) is
`pending` for 24 hours after its first open. Asking with the device's fingerprint during that time
matches it to the campaign link click it most likely followed (`matchType` `probabilistic`). A link,
referrer or APK campaign is `deterministic` and always wins; once the campaign is no longer pending
(`isPending()`) the answer is final.

Calls block: make them from a worker thread, never from SmartFox's I/O threads.

## Baziness Pay

Baziness Pay is the web checkout (`pay.baziness.com`) for packages registered in Pay under your app's
package name. The device opens the checkout and, when the player taps "Complete purchase", finds the
paid payment and sends its token to your server:

```java
Pay pay = baziness.pay("com.example.game");          // your app in Baziness Pay (Pay's pname)
if (pay.verify(playerId, sku, token)) {              // your player id; the token must be this payment's
    grantOnce(playerId, sku, token);                 // your own grant, once per token
    pay.consume(playerId, sku);                      // the player can buy it again
}
Pay.Payment payment = pay.find(playerId, sku);       // or null: complete it without a device token
```

Report each payment you granted like any other purchase: `purchases().record` with gateway
`baziness_pay` and the payment's token as the order id (provider: `payment.gateway`, when you have it).
`BAZINESS_PAY_BASE_URL` (or `Builder.payBaseUrl`) overrides the environment's Pay address.

```bash
./build.sh           # javac --release 8 → out/baziness-server-2.0.0.jar, then 17 tests (needs Node for the fake platform)
```
