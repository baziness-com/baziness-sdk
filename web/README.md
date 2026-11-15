# @baziness/web

Baziness for the **player's browser** in a web game: Baziness pages (sign-in, profile, the
«انتخاب جایزه» reward shop, your game offer) in an overlay, the Gita coin balance, first-touch
attribution (with your wrapper app's tracker: AppMetrica device id, deferred deep links), device info and
player analytics. It holds no secret: sessions and link codes come
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

## Attribution from the app that wraps your game

A web game shipped inside an app (a WebView, Capacitor, a Trusted Web Activity) has its attribution SDK
(AppMetrica, Metrix) in the app. Pass what it gives to the page:

```ts
// The AppMetrica device id: Android AppMetrica.requestStartupParams(…, APPMETRICA_DEVICE_ID_HASH) → deviceIdHash.
// It is the appmetrica_device_id of AppMetrica's exports and postbacks; DeviceId is another value.
baziness.reportTrackerDevice('appmetrica', deviceIdHash);  // before or after start(); sent once per player

// A tracker's answer: AppMetrica's deferred deep link parameters (bz_lc, bz_click, UTMs), Metrix's acquisition*.
await baziness.reportTrackerAttribution('appmetrica', parameters);
await baziness.setInstallReferrer(playReferrer);           // the store install referrer, raw
```

A wrapper that cannot call JavaScript (a TWA) opens the game with `?appmetrica_device_id=<hash>`: the SDK
reads it and removes it from the address, like the UTMs. The device id lets Baziness match AppMetrica's own
install records (Google Ads, APK installs, links without a deep link) to this install. The install keeps
its first campaign: UTMs or a Baziness link in the address, then the first tracker that answers; empty and
organic answers are skipped. Answers before the first session go with it to your server; later ones go
straight to Baziness (accepted within 24 h of the first open). The two `report…` calls and
`setInstallReferrer` never throw.

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

`openPage` slides a sheet up over the game at once, with the Baziness logo and a spinner, and shows the page
when its link code is ready and the page has loaded. The game stays in view above it, blurred and shaded. A
handle strip over the top of the page closes it when tapped (it is a button, so keyboards press it too); dragged
down, the sheet follows the finger and the shade lightens with it: let go past a quarter of the sheet and it
closes, otherwise it springs back. Tapping the game or Escape closes it too. The shade's blur radius never
changes, only its opacity, so weak phones stay smooth; reduced motion is respected. The `overlay` option of
`BazinessWeb.init` styles it:

| Option | Default | |
| --- | --- | --- |
| `topGap` | 22 px | the game left in view above the sheet: pixels (1 or more) or a part of the screen height |
| `maxWidth`, `cornerRadius` | `480`, `20` | the sheet, in pixels |
| `shade`, `blurGame`, `blurPx` | `rgba(15,23,42,.46)`, `true`, `14` | over the game, around the sheet |
| `backdrop` | `#4c1d95` | the sheet itself, seen at its edges while it slides |
| `loaderIcon`, `loaderBackground` | the Baziness logo, white | while the page loads; `loaderIcon: null` shows the spinner only |
| `spinnerColor`, `spinnerTrackColor` | `#6938ef`, `rgba(105,56,239,.18)` | the spinner |
| `handleStripHeight`, `handleSize`, `handleColor` | `32`, 96 × 4, `rgba(216,180,254,.85)` | the handle, in pixels |
| `closeLabel` | `Close` | the handle's accessible name; a function is read at each open (your language) |
| `dragToClose` | `0.25` | dragged further than this part of the sheet (160 pixels at most), it closes when let go |
| `container`, `zIndex` | `document.body`, on top | where it attaches; lower `zIndex` to keep your own toasts above it |
| `closeButtonAfterMs` | `false` | show a fallback close button over a page that has not loaded after this long |

A page's text to share opens the browser's share sheet; where there is none it goes to the clipboard and
`copied` fires, for your "copied" toast.

Without a bundler: `<script src="baziness.global.js"></script>` → `window.Baziness.BazinessWeb`.

`npm test` (22 tests against `../tools/fake-hub`), `npm run build` (ESM in `dist/`, 38 KB minified global build).
