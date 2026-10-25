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
await baziness.start();                       // sends ?linkCode= and attribution once
baziness.on('close', () => refreshBalance());
await baziness.openPage('shop');
const balance = await baziness.coins.balance();
baziness.analytics.track('level_complete', { value: 1200, props: { level: 7 } });
```

Without a bundler: `<script src="baziness.global.js"></script>` → `window.Baziness.BazinessWeb`.

`npm test` (9 tests against `../tools/fake-hub`), `npm run build` (ESM in `dist/`, 18 KB minified global build).
