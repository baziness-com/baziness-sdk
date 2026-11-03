# Baziness.Server

Baziness for your game **server** (.NET 8 or newer, no dependencies). Same API and behaviour as
`@baziness/server` and `baziness-server`. It keeps the client secret, gives your players' devices
their tokens and link codes, gives Gita coins, reports purchases and sends trusted analytics
(sessions, device data, sign-ins, game events). It stores no player token: the client secret gets any
of your players' tokens whenever one is needed.

## Install

```bash
dotnet add package Baziness.Server
```

## Quick start

```csharp
using Baziness.Server;

// BAZINESS_ENVIRONMENT=staging|production, BAZINESS_CLIENT_ID, BAZINESS_CLIENT_SECRET
await using var baziness = BazinessServer.FromEnv(logger: BazinessLogger.Console);

var session = await baziness.Players.SignInAsync(
    new SignInRequest(deviceId, BazinessPlatform.Web, BazinessStore.Direct) { UserId = userId, LinkCode = linkCode });
var link = await baziness.Players.LinkCodeAsync(session.UserId);          // open a Baziness page: link.Code
await baziness.Coins.AddAsync(session.UserId, 50, $"match:{matchId}");
await baziness.Purchases.RecordAsync(new RecordPurchaseRequest
{
    UserId = session.UserId, Amount = 49000, Gateway = PaymentGateway.CafeBazaar, OrderId = orderId, Sku = sku
});
baziness.Analytics.Sessions.Start(session.UserId, new SessionStartOptions { Device = device });   // on connect
baziness.Analytics.LevelComplete(session.UserId, "7", score: 1200);       // one method per event
baziness.Analytics.Sessions.End(session.UserId);                          // on disconnect
var bazinessUserId = await baziness.Players.FindByPhoneAsync("09121234567");   // or null
var bundleId = await baziness.Offers.GetAsync(playerId);                  // your player id; or null
await baziness.CloseAsync();                                              // on shutdown
```

One instance per process; it is safe to share. With a DI container, register it as a singleton:

```csharp
services.AddSingleton(provider =>
{
    var log = provider.GetRequiredService<ILogger<BazinessServer>>();
    return new BazinessServer(new BazinessServerOptions
    {
        Environment = BazinessEnvironment.Staging,   // Production after the platform team's review
        ClientId = clientId,
        ClientSecret = clientSecret,
        Logger = BazinessLogger.From(
            m => log.LogInformation("{Message}", m),
            m => log.LogWarning("{Message}", m),
            m => log.LogError("{Message}", m))
    });
});
```

`BazinessServer` is `IAsyncDisposable`, so the container sends the remaining analytics when it shuts down.
Every call that goes to the network takes an optional `CancellationToken`.

## The player's install campaign

```csharp
// When the player opens the game: the device as your server saw it.
var campaign = await baziness.Players.CampaignAsync(userId, new DeviceFingerprint
{
    Ip = request.HttpContext.Connection.RemoteIpAddress?.ToString(),   // with a proxy in front: the forwarded one
    UserAgent = request.Headers.UserAgent,
    DeviceModel = device.Model,                                        // from the device SDK's DeviceInfo
    OsVersion = device.OsVersion
});
// campaign.Status "attributed", campaign.MatchType "probabilistic", campaign.UtmSource, campaign.CampaignCode …
```

An install that came with no campaign (no campaign link, UTMs, store referrer or APK campaign) is
`pending` for 24 hours after its first open. Asking with the device's fingerprint during that time
matches it to the campaign link click it most likely followed (`MatchType` `probabilistic`). A link,
referrer or APK campaign is `deterministic` and always wins; once the campaign is no longer pending
(`IsPending`) the answer is final. The web and Unity SDKs can also ask from the device itself
(`campaign.get()`, `BazinessSdk.GetCampaignAsync()`).

## Baziness Pay

Baziness Pay is the web checkout (`pay.baziness.com`) for packages registered in Pay under your app's
package name. The device opens the checkout and, when the player taps "Complete purchase", finds the
paid payment and sends its token to your server:

```csharp
var pay = baziness.Pay("com.example.game");             // your app in Baziness Pay (Pay's pname)
if (await pay.VerifyAsync(playerId, sku, token))        // your player id; the token must be this payment's
{
    await GrantOnce(playerId, sku, token);              // your own grant, once per token
    await pay.ConsumeAsync(playerId, sku);              // the player can buy it again
}
var payment = await pay.FindAsync(playerId, sku);       // or null: complete it without a device token
```

Report each payment you granted like any other purchase: `Purchases.RecordAsync` with gateway
`PaymentGateway.BazinessPay` and the payment's token as the order id (provider: `payment.Gateway`, when you
have it). `BAZINESS_PAY_BASE_URL` (or `BazinessServerOptions.PayBaseUrl`) overrides the environment's Pay
address.

## Errors

A failed call throws `BazinessException`, with the platform's `Code` and the HTTP `Status` when it answered.
`IsUnavailable` means the platform could not be reached or answered 5xx: carry on without it. An expired or used
link code is not an error (`LinkCodeRejected`), analytics never throws, and the SDK retries what is safe to retry,
within a 15-second budget per call.

```bash
./build.sh           # 48 tests against the shared fake platform (needs Node), then out/Baziness.Server.<version>.nupkg
```
