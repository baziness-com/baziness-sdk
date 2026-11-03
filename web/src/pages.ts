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
  /** The game left in view above the sheet, as a part of the screen height. Default 0.08. */
  topGap?: number;
  /** Over the game, above the sheet. Default `rgba(8,6,4,.5)`. */
  shade?: string;
  /** The game shows blurred above the sheet. Default true. */
  blurGame?: boolean;
  /** The sheet behind the page while it loads and slides in, and behind the handle. Default white. */
  backdrop?: string;
  /** The sheet's top corners, in pixels. Default 22. */
  cornerRadius?: number;
  /** The top of the sheet with the handle, in pixels: tap it to close, or drag it down. Default 26. */
  handleStripHeight?: number;
  /** Default 44 × 5 pixels. */
  handleSize?: { width: number; height: number };
  /** Default `rgba(0,0,0,.22)`. */
  handleColor?: string;
  /**
   * Dragged further down than this part of the sheet (150 pixels at most), it closes when let go; less,
   * it springs back. Default 0.28.
   */
  dragToClose?: number;
}

const SLIDE_MS = 320;
const SLIDE_EASING = 'cubic-bezier(.22,.61,.36,1)';
const MAX_DRAG_TO_CLOSE_PX = 150;
/** A press on the handle that moves less than this is a tap. */
const TAP_PX = 6;

/** Whether letting go of the handle closes the sheet; otherwise it springs back. */
export function dragCloses(dragged: number, sheetHeight: number, dragToClose: number): boolean {
  return dragged > Math.min(MAX_DRAG_TO_CLOSE_PX, sheetHeight * dragToClose);
}

/**
 * The in-game view of a page: a sheet that slides up over the game, which stays in view above it, blurred
 * and shaded, with the page in an iframe under a handle. Tapping the game or the handle closes it, and so
 * does dragging the handle down (dragged a little, it springs back). Only the handle drags: the iframe
 * keeps its own touches for the page. Only one is open at a time. The page closes it with its own close
 * message; a fallback close button appears if the page does not load.
 */
export class PageOverlay {
  private root: HTMLDivElement | null = null;
  private shade: HTMLDivElement | null = null;
  private sheet: HTMLDivElement | null = null;
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
    const backdrop = this.options.backdrop ?? '#fff';
    const cornerRadius = this.options.cornerRadius ?? 22;
    const topGap = Math.min(Math.max(this.options.topGap ?? 0.08, 0), 0.9);

    const root = document.createElement('div');
    root.setAttribute('data-baziness-overlay', '');
    root.setAttribute('role', 'dialog');
    root.setAttribute('aria-modal', 'true');
    Object.assign(root.style, {
      position: 'fixed',
      inset: '0',
      zIndex: String(this.options.zIndex ?? 2147483000),
      display: 'flex',
      alignItems: 'flex-end',
      justifyContent: 'center',
    } satisfies Partial<CSSStyleDeclaration>);

    const shade = document.createElement('div');
    shade.setAttribute('data-baziness-shade', '');
    Object.assign(shade.style, {
      position: 'absolute',
      inset: '0',
      background: this.options.shade ?? 'rgba(8,6,4,.5)',
      opacity: '0',
      transition: `opacity ${SLIDE_MS}ms ease`,
    } satisfies Partial<CSSStyleDeclaration>);
    if (this.options.blurGame !== false) {
      shade.style.setProperty('backdrop-filter', 'blur(3px)');
      shade.style.setProperty('-webkit-backdrop-filter', 'blur(3px)');
    }
    shade.addEventListener('click', () => this.close());

    const sheet = document.createElement('div');
    sheet.setAttribute('data-baziness-sheet', '');
    Object.assign(sheet.style, {
      position: 'relative',
      display: 'flex',
      flexDirection: 'column',
      width: '100%',
      maxWidth: '560px',
      height: `calc(${(1 - topGap) * 100}% - env(safe-area-inset-top, 0px))`,
      background: backdrop,
      borderRadius: `${cornerRadius}px ${cornerRadius}px 0 0`,
      overflow: 'hidden',
      transform: 'translateY(100%)',
      transition: `transform ${SLIDE_MS}ms ${SLIDE_EASING}`,
      boxShadow: '0 -10px 34px rgba(0,0,0,.42)',
      willChange: 'transform',
    } satisfies Partial<CSSStyleDeclaration>);

    const handle = document.createElement('div');
    handle.setAttribute('data-baziness-handle', '');
    handle.setAttribute('aria-hidden', 'true'); // Escape and the page's own button do this from the keyboard
    Object.assign(handle.style, {
      flex: '0 0 auto',
      height: `${this.options.handleStripHeight ?? 26}px`,
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      background: backdrop,
      cursor: 'grab',
      touchAction: 'none',
      userSelect: 'none',
    } satisfies Partial<CSSStyleDeclaration>);
    const pill = document.createElement('div');
    Object.assign(pill.style, {
      width: `${this.options.handleSize?.width ?? 44}px`,
      height: `${this.options.handleSize?.height ?? 5}px`,
      borderRadius: '999px',
      background: this.options.handleColor ?? 'rgba(0,0,0,.22)',
    } satisfies Partial<CSSStyleDeclaration>);
    handle.append(pill);

    const page = document.createElement('div');
    Object.assign(page.style, {
      position: 'relative',
      flex: '1 1 auto',
      minHeight: '0',
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
    this.keyHandler = (event) => {
      if (event.key === 'Escape') this.close();
    };
    document.addEventListener('keydown', this.keyHandler);

    this.followDrags(handle, sheet, iframe);

    page.append(style, spinner, iframe, closeButton);
    sheet.append(handle, page);
    root.append(shade, sheet);
    (this.options.container ?? document.body).append(root);
    root.dataset.fallbackTimer = String(fallback);
    this.root = root;
    this.shade = shade;
    this.sheet = sheet;
    this.iframe = iframe;
    // The starting position must have been drawn, or the sheet appears without sliding.
    void sheet.getBoundingClientRect();
    requestAnimationFrame(() => {
      if (this.root !== root) return; // closed before it could slide in
      shade.style.opacity = '1';
      sheet.style.transform = 'translateY(0)';
    });
  }

  close(): void {
    const root = this.root;
    if (!root) return;
    const { shade, sheet } = this;
    this.root = null;
    this.shade = null;
    this.sheet = null;
    this.iframe = null;
    clearTimeout(Number(root.dataset.fallbackTimer));
    if (this.keyHandler) document.removeEventListener('keydown', this.keyHandler);
    this.keyHandler = null;
    root.style.pointerEvents = 'none'; // the game takes the next tap, while the sheet slides away
    if (shade) shade.style.opacity = '0';
    if (sheet) {
      sheet.style.transition = `transform ${SLIDE_MS}ms ${SLIDE_EASING}`; // it may be closing from a drag
      sheet.style.transform = 'translateY(100%)';
    }
    setTimeout(() => root.remove(), SLIDE_MS + 20);
    const onClosed = this.onClosed;
    this.onClosed = null;
    onClosed?.();
  }

  /** The sheet follows the handle down. Letting go closes it or springs it back; a tap closes it. */
  private followDrags(handle: HTMLElement, sheet: HTMLElement, iframe: HTMLIFrameElement): void {
    let pointerId: number | null = null;
    let startY = 0;
    let dragged = 0;
    let moved = 0;

    const finish = (): void => {
      pointerId = null;
      handle.style.cursor = 'grab';
      iframe.style.pointerEvents = '';
      sheet.style.transition = `transform ${SLIDE_MS}ms ${SLIDE_EASING}`;
    };

    handle.addEventListener('pointerdown', (event) => {
      if (pointerId !== null) return;
      pointerId = event.pointerId;
      startY = event.clientY;
      dragged = 0;
      moved = 0;
      handle.setPointerCapture(event.pointerId);
      handle.style.cursor = 'grabbing';
      iframe.style.pointerEvents = 'none';
      sheet.style.transition = 'none';
    });
    handle.addEventListener('pointermove', (event) => {
      if (event.pointerId !== pointerId) return;
      moved = Math.max(moved, Math.abs(event.clientY - startY));
      dragged = Math.max(0, event.clientY - startY); // only down
      sheet.style.transform = `translateY(${dragged}px)`;
    });
    handle.addEventListener('pointerup', (event) => {
      if (event.pointerId !== pointerId) return;
      finish();
      const dragToClose = this.options.dragToClose ?? 0.28;
      if (moved < TAP_PX || dragCloses(dragged, sheet.getBoundingClientRect().height, dragToClose)) this.close();
      else sheet.style.transform = 'translateY(0)';
    });
    handle.addEventListener('pointercancel', (event) => {
      if (event.pointerId !== pointerId) return;
      finish();
      sheet.style.transform = 'translateY(0)';
    });
  }
}
