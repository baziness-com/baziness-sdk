import { DeviceAnalytics, type DeviceAnalyticsOptions } from './analytics.js';
import type { BackendSession, GameBackend } from './backend.js';
import { InstallCampaign, type RecordOutcome } from './campaign.js';
import { CoinBalance, ReferralRewards } from './coins.js';
import { collectDevice, refineDevice, SDK_VERSION, type DeviceInfo } from './device.js';
import { ENVIRONMENTS, type BazinessEnvironment } from './environment.js';
import { readLaunch, saveAttribution, type Attribution, type LaunchParams } from './launch.js';
import { pageUrl, parsePageMessage, type PageMessage, type PageName } from './pages.js';
import { PageOverlay, type OverlayOptions } from './sheet.js';
import { BazinessPay } from './pay.js';
import { SessionManager } from './session.js';
import { browserStore, uuid, type KeyValueStore } from './storage.js';
import { hasCampaign, TRACKER_ANSWER_EVENT, trackerAttribution, TrackerDevices } from './tracker.js';

export interface BazinessWebOptions {
  /** `staging` while you integrate; `production` after the platform team's review. */
  environment: BazinessEnvironment;
  /** Your platform package name (`packageName` on every page). */
  packageName: string;
  /** Your game name (`game_name` on the reward and game-offer pages). */
  gameName?: string;
  appVersion?: string;
  /** `CafeBazaar` / `Myket` for store builds (wrapped web games). */
  buildStore?: string;
  /** Your server's side: sessions, link codes, login, logout. See `httpBackend`. */
  backend: GameBackend;
  analytics?: DeviceAnalyticsOptions;
  overlay?: OverlayOptions;
  /** Overrides, e.g. a local platform stack. */
  apiBaseUrl?: string;
  pagesBaseUrl?: string;
  /** The Baziness Pay address your game already uses, instead of the environment's. */
  payBaseUrl?: string;
  /** Your app in Baziness Pay (Pay's `pname`). Default: `packageName`. */
  payPackageName?: string;
  /** Read launch parameters from this address instead of `location.href`. */
  href?: string;
  storage?: KeyValueStore;
  fetch?: typeof fetch;
}

export interface BazinessEvents {
  /** A new session (or `null` after logout). Extra fields your server sent are on it. */
  session: BackendSession | null;
  /** The player signed in on a page; your server already verified and linked the token. */
  login: { result: unknown };
  /** The player signed out on a page; start over as a new visitor. */
  logout: void;
  /** A page opened / closed. Refresh the coin balance on close. */
  open: PageName | string;
  close: PageName | string;
  share: string;
  /** A page's text to share went to the clipboard (no share sheet here): tell the player it was copied. */
  copied: string;
  error: Error;
}

type Handler<T> = (payload: T) => void;

/**
 * The Baziness SDK for web games.
 *
 * ```ts
 * const baziness = BazinessWeb.init({
 *   environment: 'staging', packageName: 'com.example.game', gameName: 'example',
 *   backend: httpBackend('/api/baziness'),
 * });
 * await baziness.start();
 * baziness.openPage('shop');
 * ```
 */
export class BazinessWeb {
  readonly environment: BazinessEnvironment;
  readonly device: DeviceInfo;
  readonly launch: LaunchParams;
  readonly analytics: DeviceAnalytics;
  readonly coins: CoinBalance;
  readonly referrals: ReferralRewards;
  /** The player's install campaign (`campaign.get()`), matched by this device's fingerprint while pending. */
  readonly campaign: InstallCampaign;
  /** Baziness Pay, the web checkout: `openCheckout`, then `findPayment` when the player says they paid. */
  readonly pay: BazinessPay;

  private readonly options: BazinessWebOptions;
  private readonly store: KeyValueStore;
  private readonly trackerDevices: TrackerDevices;
  private firstTouch: Attribution | null;
  private readonly apiBase: string;
  private readonly pagesBase: string;
  private readonly pagesOrigin: string;
  private readonly sessions: SessionManager;
  private readonly overlay: PageOverlay;
  private readonly handlers = new Map<keyof BazinessEvents, Set<Handler<never>>>();
  private readonly cleanups: Array<() => void> = [];
  private readonly refined: Promise<DeviceInfo>;
  private openPageName: string | null = null;
  private openedAt = 0;

  static init(options: BazinessWebOptions): BazinessWeb {
    return new BazinessWeb(options);
  }

  constructor(options: BazinessWebOptions) {
    if (options.environment !== 'staging' && options.environment !== 'production') {
      throw new TypeError(`Baziness: environment must be "staging" or "production", got "${options.environment}"`);
    }
    if (!options.packageName) throw new TypeError('Baziness: packageName is required');
    if (!options.backend) throw new TypeError('Baziness: backend is required (see httpBackend)');
    this.options = options;
    this.environment = options.environment;
    const urls = ENVIRONMENTS[options.environment];
    this.apiBase = (options.apiBaseUrl ?? urls.api).replace(/\/+$/, '');
    this.pagesBase = (options.pagesBaseUrl ?? urls.pages).replace(/\/+$/, '');
    this.pagesOrigin = new URL(this.pagesBase).origin;
    const store = (this.store = options.storage ?? browserStore());
    const fetchImpl = options.fetch ?? fetch.bind(globalThis);

    const href = options.href ?? (typeof location === 'undefined' ? 'http://localhost/' : location.href);
    const referrer = typeof document === 'undefined' ? '' : document.referrer;
    const { launch, cleanHref } = readLaunch(href, referrer, store);
    if (cleanHref && !options.href && typeof history !== 'undefined') {
      // The link code works once and none of these belong in history or in a shared link.
      history.replaceState(history.state, '', cleanHref);
    }
    this.launch = launch;
    this.firstTouch = launch.attribution;
    this.device = collectDevice(store, options.appVersion);

    this.sessions = new SessionManager(options.backend, this.device, launch);
    const token = (force: boolean) => this.sessions.token(force);
    this.analytics = new DeviceAnalytics(this.apiBase, token, store, options.packageName, fetchImpl, options.analytics);
    this.analytics.sessionId = uuid();
    this.analytics.appVersion = options.appVersion;
    this.coins = new CoinBalance(this.apiBase, token, fetchImpl);
    this.referrals = new ReferralRewards(this.apiBase, token, fetchImpl);
    this.campaign = new InstallCampaign(this.apiBase, token, this.device, fetchImpl);
    this.pay = new BazinessPay(options.payBaseUrl ?? urls.pay, options.payPackageName ?? options.packageName, fetchImpl);
    this.overlay = new PageOverlay(options.overlay);
    this.refined = refineDevice(this.device);
    this.trackerDevices = new TrackerDevices(this.analytics, store);
    for (const [tracker, id] of Object.entries(launch.trackerDevices ?? {})) this.trackerDevices.report(tracker, id);

    this.sessions.onChange((session) => {
      if (session?.sessionId) this.analytics.sessionId = session.sessionId;
      this.trackerDevices.send(session?.userId);
      this.emit('session', session);
    });
    this.listen();
  }

  /**
   * Get the first session from your server (sends the launch link code, attribution and the device,
   * with its real model and OS version where the browser gives them).
   */
  async start(): Promise<BackendSession> {
    await this.refined;
    return this.sessions.get();
  }

  /**
   * First-touch attribution of this install: the landing's campaign parameters or referrer, or what
   * {@link setInstallReferrer} and {@link reportTrackerAttribution} added; null when it came with none.
   */
  get attribution(): Attribution | null {
    return this.firstTouch;
  }

  /**
   * Tell Baziness the id an attribution tracker gave this device, so Baziness can read the install's
   * campaign from that tracker's own records. Needed for trackers that never tell the app their
   * attribution (AppMetrica: Google Ads installs, APK installs, links without a deep link). A web game
   * gets it from the app that wraps it (a JavaScript bridge in a WebView, a Capacitor plugin); a wrapper
   * that cannot call JavaScript (a Trusted Web Activity) opens the game with `?appmetrica_device_id=`
   * instead, which the SDK reads for you. Call it whenever the id comes, before or after {@link start};
   * it is sent once per player (event `baziness:tracker:device`).
   *
   * ```ts
   * // Android wrapper: AppMetrica.requestStartupParams(…, listOf(StartupParamsCallback.APPMETRICA_DEVICE_ID_HASH))
   * // → webView.evaluateJavascript("onAppMetricaDevice('" + result.deviceIdHash + "')", null)
   * window.onAppMetricaDevice = (id: string) => baziness.reportTrackerDevice('appmetrica', id);
   * ```
   * @param tracker Which tracker the id belongs to, e.g. `appmetrica`.
   * @param deviceId The tracker's own device id (AppMetrica: the device id **hash**, the
   *   `appmetrica_device_id` of its exports), never an advertising id.
   */
  reportTrackerDevice(tracker: string, deviceId: string): void {
    if (this.trackerDevices.report(tracker, deviceId)) this.trackerDevices.send(this.sessions.session?.userId);
  }

  /**
   * Pass every attribution SDK's answer here as it comes (Metrix, AppMetrica, Adjust, …), for example
   * from the wrapper app's bridge. Give what the tracker gave: UTMs, AppMetrica's deferred deep link
   * parameters (they carry a Baziness link's `bz_lc` and `bz_click`), or its own field names (`source`,
   * `campaign`, `adset`, `ad`; Metrix's `acquisitionSource`, …). The install keeps its first campaign:
   * a Baziness link or UTMs in the address come first, then the first tracker that answers; empty and
   * organic answers are skipped. Sent with the first session, or straight to Baziness after it
   * (accepted within 24 h of the first open). Never rejects: a failure is logged.
   *
   * ```ts
   * // AppMetrica (Android wrapper): requestDeferredDeeplinkParameters → the parameters as JSON
   * window.onAppMetricaDeeplink = (json: string) => baziness.reportTrackerAttribution('appmetrica', JSON.parse(json));
   * ```
   * @param tracker Which SDK answered, e.g. `metrix` or `appmetrica`.
   */
  reportTrackerAttribution(tracker: string, values: Record<string, string | null | undefined>): Promise<void> {
    const answer = trackerAttribution(values);
    if (!answer) return Promise.resolve();
    this.analytics.record(TRACKER_ANSWER_EVENT, {
      props: { tracker: tracker?.trim().toLowerCase() ?? '', source: answer.utmSource, campaign: answer.utmCampaign },
    });
    if (hasCampaign(this.firstTouch)) return Promise.resolve();
    const { landedAt, ...campaign } = answer;
    const base = this.firstTouch ? { referrer: this.firstTouch.referrer, landedAt: this.firstTouch.landedAt } : { landedAt };
    return this.recordLate({ ...base, ...campaign });
  }

  /**
   * The raw store install referrer, for a web game shipped inside a store app (Google Play Install
   * Referrer API, Cafe Bazaar / Myket referrer SDKs in the wrapper). Ignored once the install has a
   * referrer. Sent like {@link reportTrackerAttribution}; never rejects.
   */
  setInstallReferrer(referrer: string): Promise<void> {
    const value = referrer?.trim();
    if (!value || this.firstTouch?.referrer) return Promise.resolve();
    return this.recordLate({ ...(this.firstTouch ?? { landedAt: new Date().toISOString() }), referrer: value.slice(0, 1024) });
  }

  /** The current session, if any. */
  get session(): BackendSession | null {
    return this.sessions.session;
  }

  /** A valid player token (renewed through your server when needed). */
  token(): Promise<string> {
    return this.sessions.token();
  }

  /** Re-ask your server, e.g. after your own sign-in changed the player. */
  refreshSession(): Promise<BackendSession> {
    return this.sessions.get(true);
  }

  /**
   * Open a Baziness page over the game. The sheet slides up at once with the loader, and shows the page
   * as soon as its fresh link code is ready. When there is no link code (Baziness unreachable), the sheet
   * closes again (`close` event) and this rejects.
   */
  async openPage(page: PageName | string, query?: Record<string, string>): Promise<void> {
    const sheet = this.overlay.open(() => this.pageClosed(page));
    this.openPageName = page;
    this.openedAt = Date.now();
    this.analytics.record('baziness:page:open', { props: { page } });
    this.emit('open', page);
    let url: string;
    try {
      url = await this.pageUrl(page, query);
    } catch (error) {
      this.overlay.close(sheet);
      throw error;
    }
    this.overlay.load(sheet, url);
  }

  closePage(): void {
    if (this.overlay.isOpen) this.overlay.close(); // calls pageClosed
    else if (this.openPageName) this.pageClosed(this.openPageName); // a page in your own view
  }

  /** The address of a page with a fresh link code, for games that render the page themselves. */
  async pageUrl(page: PageName | string, query?: Record<string, string>): Promise<string> {
    await this.sessions.get();
    const linkCode = await this.options.backend.linkCode();
    if (!this.overlay.isOpen) {
      // Shown in your own view: its messages come through handlePageMessage.
      this.openPageName = page;
      this.openedAt = Date.now();
    }
    return pageUrl({
      pagesBase: this.pagesBase,
      page,
      packageName: this.options.packageName,
      gameName: this.options.gameName,
      linkCode,
      buildStore: this.options.buildStore,
      appVersion: this.options.appVersion,
      sdkVersion: SDK_VERSION,
      query,
    });
  }

  /**
   * Handle a page message yourself (your own web view). Pass only messages from the pages origin;
   * the built-in overlay already does this.
   */
  async handlePageMessage(message: PageMessage): Promise<void> {
    const page = this.openPageName ?? 'page';
    switch (message.type) {
      case 'close':
        this.closePage();
        return;
      case 'token':
        return; // a handshake when a page loads, never a sign-in
      case 'login': {
        try {
          const result = message.token ? await this.options.backend.login(message.token) : undefined;
          await this.sessions.get(true);
          this.analytics.record('baziness:page:login', { props: { page } });
          this.emit('login', { result });
          if (message.token) this.closePage();
        } catch (error) {
          this.emit('error', error as Error);
        }
        return;
      }
      case 'logout':
        try {
          await this.options.backend.logout();
        } catch (error) {
          this.emit('error', error as Error);
        }
        this.analytics.record('baziness:page:logout', { props: { page } });
        this.sessions.clear();
        this.closePage();
        this.emit('logout', undefined);
        return;
      case 'open_url':
        window.open(message.url, '_blank', 'noopener');
        return;
      case 'share_text':
        if ((await share(message.text)) === 'copied') this.emit('copied', message.text);
        this.emit('share', message.text);
        return;
    }
  }

  on<K extends keyof BazinessEvents>(event: K, handler: Handler<BazinessEvents[K]>): () => void {
    let set = this.handlers.get(event);
    if (!set) {
      set = new Set();
      this.handlers.set(event, set);
    }
    set.add(handler as Handler<never>);
    return () => set!.delete(handler as Handler<never>);
  }

  /** Remove listeners and timers (single-page apps that unmount the game). */
  destroy(): void {
    this.closePage();
    this.analytics.stop();
    for (const cleanup of this.cleanups.splice(0)) cleanup();
  }

  private async recordLate(attribution: Attribution): Promise<void> {
    this.firstTouch = attribution;
    saveAttribution(this.store, attribution);
    this.sessions.useAttribution(attribution);
    // Not asked yet: it goes with the first session request. Asked: that request may already be on its
    // way without it, so it goes to Baziness once there is a session.
    if (!this.sessions.started) return;
    let outcome: RecordOutcome;
    try {
      await this.sessions.get();
      outcome = await this.campaign.record(attribution);
    } catch (error) {
      console.warn('[baziness] attribution not recorded:', (error as Error)?.message ?? error);
      return;
    }
    if (outcome === 'window_closed') console.warn('[baziness] attribution not recorded: more than 24 h after the first open');
  }

  private pageClosed(page: string): void {
    this.analytics.record('baziness:page:close', {
      value: Math.round((Date.now() - this.openedAt) / 1000),
      props: { page },
    });
    this.openPageName = null;
    this.emit('close', page);
  }

  private listen(): void {
    if (typeof window === 'undefined') return;
    const onMessage = (event: MessageEvent) => {
      // Only the built-in overlay's page; your own view forwards through handlePageMessage.
      if (event.origin !== this.pagesOrigin || !this.overlay.isOpen || event.source !== this.overlay.frameWindow) return;
      const message = parsePageMessage(event.data);
      if (message) void this.handlePageMessage(message);
    };
    const onHide = () => {
      if (document.visibilityState === 'hidden') void this.analytics.flush(true);
    };
    const onPageHide = () => void this.analytics.flush(true);
    window.addEventListener('message', onMessage);
    document.addEventListener('visibilitychange', onHide);
    window.addEventListener('pagehide', onPageHide);
    this.cleanups.push(
      () => window.removeEventListener('message', onMessage),
      () => document.removeEventListener('visibilitychange', onHide),
      () => window.removeEventListener('pagehide', onPageHide),
    );
  }

  private emit<K extends keyof BazinessEvents>(event: K, payload: BazinessEvents[K]): void {
    for (const handler of this.handlers.get(event) ?? []) {
      try {
        (handler as Handler<BazinessEvents[K]>)(payload);
      } catch (error) {
        console.error('[baziness] event handler failed', error);
      }
    }
  }
}

/**
 * The browser's share sheet on the game's own document (a page cannot open it from inside the frame),
 * or the clipboard where there is none. A player who cancels the sheet has been served: nothing is copied.
 */
async function share(text: string): Promise<'shared' | 'copied' | 'failed'> {
  const nav = typeof navigator === 'undefined' ? undefined : navigator;
  const value = text?.trim();
  if (!value) return 'failed';
  if (nav?.share) {
    try {
      await nav.share({ text: value });
      return 'shared';
    } catch (error) {
      if ((error as { name?: string } | null)?.name === 'AbortError') return 'shared';
      // blocked: fall back to the clipboard
    }
  }
  try {
    if (!nav?.clipboard) return 'failed';
    await nav.clipboard.writeText(value);
    return 'copied';
  } catch {
    return 'failed';
  }
}
