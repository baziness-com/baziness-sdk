import { DeviceAnalytics, type DeviceAnalyticsOptions } from './analytics.js';
import type { BackendSession, GameBackend } from './backend.js';
import { CoinBalance, ReferralRewards } from './coins.js';
import { collectDevice, SDK_VERSION, type DeviceInfo } from './device.js';
import { ENVIRONMENTS, type BazinessEnvironment } from './environment.js';
import { readLaunch, type Attribution, type LaunchParams } from './launch.js';
import { PageOverlay, pageUrl, parsePageMessage, type OverlayOptions, type PageMessage, type PageName } from './pages.js';
import { SessionManager } from './session.js';
import { browserStore, uuid, type KeyValueStore } from './storage.js';

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
  /** First-touch attribution of this browser, or null when it came with none. */
  readonly attribution: Attribution | null;
  readonly launch: LaunchParams;
  readonly analytics: DeviceAnalytics;
  readonly coins: CoinBalance;
  readonly referrals: ReferralRewards;

  private readonly options: BazinessWebOptions;
  private readonly apiBase: string;
  private readonly pagesBase: string;
  private readonly pagesOrigin: string;
  private readonly sessions: SessionManager;
  private readonly overlay: PageOverlay;
  private readonly handlers = new Map<keyof BazinessEvents, Set<Handler<never>>>();
  private readonly cleanups: Array<() => void> = [];
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
    const store = options.storage ?? browserStore();
    const fetchImpl = options.fetch ?? fetch.bind(globalThis);

    const href = options.href ?? (typeof location === 'undefined' ? 'http://localhost/' : location.href);
    const referrer = typeof document === 'undefined' ? '' : document.referrer;
    const { launch, cleanHref } = readLaunch(href, referrer, store);
    if (cleanHref && !options.href && typeof history !== 'undefined') {
      // The link code works once and none of these belong in history or in a shared link.
      history.replaceState(history.state, '', cleanHref);
    }
    this.launch = launch;
    this.attribution = launch.attribution;
    this.device = collectDevice(store, options.appVersion);

    this.sessions = new SessionManager(options.backend, this.device, launch);
    const token = (force: boolean) => this.sessions.token(force);
    this.analytics = new DeviceAnalytics(this.apiBase, token, store, options.packageName, fetchImpl, options.analytics);
    this.analytics.sessionId = uuid();
    this.analytics.appVersion = options.appVersion;
    this.coins = new CoinBalance(this.apiBase, token, fetchImpl);
    this.referrals = new ReferralRewards(this.apiBase, token, fetchImpl);
    this.overlay = new PageOverlay(options.overlay);

    this.sessions.onChange((session) => {
      if (session?.sessionId) this.analytics.sessionId = session.sessionId;
      this.emit('session', session);
    });
    this.listen();
  }

  /** Get the first session from your server (sends the launch link code and attribution). */
  start(): Promise<BackendSession> {
    return this.sessions.get();
  }

  /** The current session, if any. */
  get session(): BackendSession | null {
    return this.sessions.session;
  }

  /** A valid 15-minute access token (renewed through your server when needed). */
  token(): Promise<string> {
    return this.sessions.token();
  }

  /** Re-ask your server, e.g. after your own sign-in changed the player. */
  refreshSession(): Promise<BackendSession> {
    return this.sessions.get(true);
  }

  /** Open a Baziness page over the game with a fresh link code. */
  async openPage(page: PageName | string, query?: Record<string, string>): Promise<void> {
    const url = await this.pageUrl(page, query);
    this.openPageName = page;
    this.openedAt = Date.now();
    this.overlay.open(url, () => this.pageClosed(page));
    this.analytics.record('baziness:page:open', { props: { page } });
    this.emit('open', page);
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
        await share(message.text);
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

async function share(text: string): Promise<void> {
  const nav = typeof navigator === 'undefined' ? undefined : navigator;
  try {
    if (nav?.share) {
      await nav.share({ text });
      return;
    }
  } catch {
    // cancelled or blocked: fall back to the clipboard
  }
  try {
    await nav?.clipboard?.writeText(text);
  } catch {
    // nothing else to try
  }
}
