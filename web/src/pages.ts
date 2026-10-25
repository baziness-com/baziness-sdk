/** The Baziness pages a game opens, by name, or any other page path on the pages site. */
export type PageName = 'login' | 'profile' | 'shop' | 'game-offer' | 'referral';

export interface PageUrlInput {
  pagesBase: string;
  page: PageName | string;
  packageName: string;
  gameName?: string;
  linkCode?: string;
  /** `CafeBazaar` / `Myket` builds hide links to the other stores. */
  buildStore?: string;
  appVersion?: string;
  sdkVersion: string;
  /** Extra parameters, e.g. `{ allowGuest: 'true' }`. */
  query?: Record<string, string>;
}

const PATHS: Record<PageName, string> = {
  login: '/',
  profile: '/profile',
  shop: '/shop',
  'game-offer': '/game-offer',
  referral: '/referral',
};

/** The page address with every parameter the page needs (see the wiki's page table). */
export function pageUrl(input: PageUrlInput): string {
  const page = input.page as PageName;
  const path = PATHS[page] ?? `/${String(input.page).replace(/^\/+/, '')}`;
  const params = new URLSearchParams();
  if ((page === 'shop' || page === 'game-offer') && input.gameName) params.set('game_name', input.gameName);
  params.set('packageName', input.packageName);
  params.set('sdkType', 'js');
  if (input.linkCode) params.set('linkCode', input.linkCode);
  if (page === 'profile' || page === 'shop') params.set('redirect', page);
  if (page === 'login' || page === 'profile' || page === 'game-offer') params.set('allowGuest', 'false');
  if (input.buildStore) params.set('buildStore', input.buildStore);
  if (input.appVersion) params.set('version', input.appVersion);
  params.set('sdkVersion', input.sdkVersion);
  for (const [key, value] of Object.entries(input.query ?? {})) params.set(key, value);
  return `${input.pagesBase.replace(/\/+$/, '')}${path}?${params.toString()}`;
}

export type PageMessage =
  | { type: 'close' }
  /** `token` is absent when the current account was linked in place. */
  | { type: 'login'; token?: string }
  /** A silent handshake when a page loads: never a sign-in. */
  | { type: 'token' }
  | { type: 'logout' }
  | { type: 'open_url'; url: string }
  | { type: 'share_text'; text: string };

/** A page's `postMessage` payload (JSON string or object), or null for anything else. */
export function parsePageMessage(data: unknown): PageMessage | null {
  let message: unknown = data;
  if (typeof data === 'string') {
    try {
      message = JSON.parse(data);
    } catch {
      return null;
    }
  }
  if (!message || typeof message !== 'object') return null;
  const { type, data: payload } = message as { type?: unknown; data?: unknown };
  switch (type) {
    case 'close':
    case 'logout':
    case 'token':
      return { type };
    case 'login': {
      const token = typeof payload === 'string' ? payload : (payload as { token?: unknown } | null)?.token;
      return typeof token === 'string' && token ? { type: 'login', token } : { type: 'login' };
    }
    case 'open_url':
      return typeof payload === 'string' && /^https?:\/\//.test(payload) ? { type: 'open_url', url: payload } : null;
    case 'share_text':
      return typeof payload === 'string' ? { type: 'share_text', text: payload } : null;
    default:
      return null;
  }
}

export interface OverlayOptions {
  /** Where the overlay is attached. Default `document.body`. */
  container?: HTMLElement;
  zIndex?: number;
  /** Show the fallback close button after this long if the page has not loaded. Default 3000 ms. */
  closeButtonAfterMs?: number;
}

/**
 * The in-game view of a page: a full-height sheet that slides up over the game, with an iframe in
 * it. Only one is open at a time. The page closes it with its own close message; a fallback close
 * button appears if the page does not load.
 */
export class PageOverlay {
  private root: HTMLDivElement | null = null;
  private iframe: HTMLIFrameElement | null = null;
  private onClosed: (() => void) | null = null;
  private keyHandler: ((event: KeyboardEvent) => void) | null = null;

  constructor(private readonly options: OverlayOptions = {}) {}

  get isOpen(): boolean {
    return this.root !== null;
  }

  /** The window of the open page, to check that a message comes from it. */
  get frameWindow(): Window | null {
    return this.iframe?.contentWindow ?? null;
  }

  open(url: string, onClosed: () => void): void {
    this.close();
    this.onClosed = onClosed;
    const root = document.createElement('div');
    root.setAttribute('data-baziness-overlay', '');
    root.setAttribute('role', 'dialog');
    root.setAttribute('aria-modal', 'true');
    Object.assign(root.style, {
      position: 'fixed',
      inset: '0',
      zIndex: String(this.options.zIndex ?? 2147483000),
      background: 'rgba(0,0,0,.45)',
      display: 'flex',
      alignItems: 'flex-end',
      justifyContent: 'center',
      opacity: '0',
      transition: 'opacity .25s ease',
    } satisfies Partial<CSSStyleDeclaration>);

    const sheet = document.createElement('div');
    Object.assign(sheet.style, {
      position: 'relative',
      width: '100%',
      maxWidth: '640px',
      height: 'calc(100% - env(safe-area-inset-top, 0px) - 12px)',
      background: '#fff',
      borderRadius: '16px 16px 0 0',
      overflow: 'hidden',
      transform: 'translateY(100%)',
      transition: 'transform .35s cubic-bezier(.22,1,.36,1)',
      boxShadow: '0 -8px 32px rgba(0,0,0,.25)',
    } satisfies Partial<CSSStyleDeclaration>);

    const spinner = document.createElement('div');
    spinner.setAttribute('aria-label', 'Loading');
    Object.assign(spinner.style, {
      position: 'absolute',
      top: '50%',
      left: '50%',
      width: '32px',
      height: '32px',
      margin: '-16px 0 0 -16px',
      border: '3px solid #e5e7eb',
      borderTopColor: '#7c3aed',
      borderRadius: '50%',
      animation: 'baziness-spin 0.8s linear infinite',
    } satisfies Partial<CSSStyleDeclaration>);
    const style = document.createElement('style');
    style.textContent = '@keyframes baziness-spin{to{transform:rotate(360deg)}}';

    const iframe = document.createElement('iframe');
    iframe.src = url;
    iframe.title = 'Baziness';
    iframe.allow = 'clipboard-write; web-share';
    iframe.referrerPolicy = 'strict-origin-when-cross-origin';
    Object.assign(iframe.style, { position: 'absolute', inset: '0', width: '100%', height: '100%', border: '0', opacity: '0' });
    iframe.addEventListener('load', () => {
      spinner.remove();
      iframe.style.opacity = '1';
      closeButton.style.display = 'none';
    });

    const closeButton = document.createElement('button');
    closeButton.type = 'button';
    closeButton.setAttribute('aria-label', 'Close');
    closeButton.textContent = '×';
    Object.assign(closeButton.style, {
      position: 'absolute',
      top: '8px',
      right: '8px',
      width: '40px',
      height: '40px',
      border: '0',
      borderRadius: '50%',
      background: 'rgba(0,0,0,.06)',
      font: '24px/40px system-ui, sans-serif',
      cursor: 'pointer',
      display: 'none',
    } satisfies Partial<CSSStyleDeclaration>);
    closeButton.addEventListener('click', () => this.close());
    const fallback = setTimeout(() => {
      if (iframe.style.opacity !== '1') closeButton.style.display = 'block';
    }, this.options.closeButtonAfterMs ?? 3000);
    root.addEventListener('click', (event) => {
      if (event.target === root) this.close();
    });
    this.keyHandler = (event) => {
      if (event.key === 'Escape') this.close();
    };
    document.addEventListener('keydown', this.keyHandler);

    sheet.append(style, spinner, iframe, closeButton);
    root.append(sheet);
    (this.options.container ?? document.body).append(root);
    root.dataset.fallbackTimer = String(fallback);
    this.root = root;
    this.iframe = iframe;
    requestAnimationFrame(() => {
      root.style.opacity = '1';
      sheet.style.transform = 'translateY(0)';
    });
  }

  close(): void {
    const root = this.root;
    if (!root) return;
    this.root = null;
    this.iframe = null;
    clearTimeout(Number(root.dataset.fallbackTimer));
    if (this.keyHandler) document.removeEventListener('keydown', this.keyHandler);
    this.keyHandler = null;
    root.style.opacity = '0';
    const sheet = root.firstElementChild as HTMLElement | null;
    if (sheet) sheet.style.transform = 'translateY(100%)';
    setTimeout(() => root.remove(), 300);
    const onClosed = this.onClosed;
    this.onClosed = null;
    onClosed?.();
  }
}
