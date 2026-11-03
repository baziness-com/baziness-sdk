# @baziness/web

Baziness for the **player's browser** in a web game: Baziness pages (sign-in, profile, the
«انتخاب جایزه» reward shop, your game offer) in an overlay, the Gita coin balance, first-touch
attribution, device info and player analytics. It holds no secret: sessions and link codes come
from your game server, which uses `@baziness/server`.

## Install

```bash
npm install @baziness/web
```

## Quick start

```ts
import { BazinessWeb, httpBackend } from '@baziness/web';

const baziness = BazinessWeb.init({
  environment: 'staging',
  packageName: 'com.example.game',
  gameName: 'example',
  backend: httpBackend('/api/baziness', { headers: () => ({ Authorization: `Bearer ${gameToken}` }) }),
});
await baziness.start();                       // sends ?linkCode=, attribution and the device once
baziness.on('close', () => refreshBalance());
await baziness.openPage('shop');
const balance = await baziness.coins.balance();
baziness.analytics.levelComplete({ level: 7, score: 1200 });   // one method per event
const campaign = await baziness.campaign.get(); // { status, matchType, utmSource, campaignCode, … }
```

`campaign.get()` asks Baziness for the player's install campaign from this device. An install that
came with no campaign (no campaign link, UTMs, store referrer or APK campaign) is `pending` for 24
hours after its first open; asking during that time matches it by this device's fingerprint (its IP
and User-Agent, plus its real model and OS version, read from Chrome's client hints where the
reduced User-Agent hides them) to the campaign link click it most likely followed:
`matchType: 'probabilistic'`. A link, referrer or APK campaign is `deterministic` and always wins.
`start()` sends that model and OS version to your server too (`SessionRequest.device`), so your
server can ask with `players.campaign` instead.

## Baziness Pay

Packages registered in Baziness Pay are paid on its web checkout. In the player's tap, show your
"complete the purchase" dialog and open the checkout; when they tap "Complete purchase", find the paid
payment and send its token to your server (server SDK: `pay.verify`, then `pay.consume`):

```ts
buyButton.onclick = () => {
  showCompletePurchaseDialog();
  void baziness.pay.openCheckout(sku, playerId);  // in the tap: browsers block a later new tab
};
completeButton.onclick = async () => {
  const payment = await baziness.pay.findPayment(sku, playerId);
  if (payment) await myServer.completePurchase(sku, payment.token);
  else showNotPaidYet();                          // keep the dialog: they can tap again
};
```

`payBaseUrl` and `payPackageName` (default: `packageName`) override the Pay address and app name.

## The page sheet

`openPage` shows the page on a sheet that slides up over the game, which stays in view above it, blurred and
shaded. A handle tops the sheet: tapping it or the game closes the page, and so does dragging it down
(dragged a little, it springs back). The `overlay` option of `BazinessWeb.init` styles it:

| Option | Default | |
| --- | --- | --- |
| `topGap` | `0.08` | the game left in view above the sheet, as a part of the screen height |
| `shade`, `blurGame` | `rgba(8,6,4,.5)`, `true` | over the game, above the sheet |
| `backdrop` | white | behind the page while it loads, and behind the handle |
| `cornerRadius` | `22` | the sheet's top corners, in pixels |
| `handleStripHeight`, `handleSize`, `handleColor` | `26`, 44 × 5, `rgba(0,0,0,.22)` | the handle, in pixels |
| `dragToClose` | `0.28` | dragged further than this part of the sheet (150 pixels at most), it closes when let go |
| `container`, `zIndex`, `closeButtonAfterMs` | `document.body`, on top, `3000` | where it attaches; when the fallback close button appears |

Without a bundler: `<script src="baziness.global.js"></script>` → `window.Baziness.BazinessWeb`.

`npm test` (14 tests against `../tools/fake-hub`), `npm run build` (ESM in `dist/`, 25 KB minified global build).
