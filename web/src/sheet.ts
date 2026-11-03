import { BAZINESS_LOGO } from './logo.js';

export interface OverlayOptions {
  /** Where the sheet is attached. Default `document.body`. */
  container?: HTMLElement;
  /** Default on top of everything (2147483000). Lower it to keep your own toasts above the sheet. */
  zIndex?: number;
  /** Accessible name of the handle, a button that closes the sheet. Default `Close`; a function is read at each open. */
  closeLabel?: string | (() => string);
  /**
   * The game left in view above the sheet: pixels (1 or more) or a part of the screen height (less
   * than 1). Default 22 pixels.
   */
  topGap?: number;
  /** The sheet's width at most, in pixels. Default 480. */
  maxWidth?: number;
  /** Over the game, around the sheet. Default `rgba(15,23,42,.46)`. */
  shade?: string;
  /** The game shows blurred around the sheet. Default true. */
  blurGame?: boolean;
  /** Blur of the game, in pixels. Default 14. */
  blurPx?: number;
  /** The sheet itself, seen at its edges while it slides. Default `#4c1d95`. */
  backdrop?: string;
  /** Behind the logo and spinner while the page loads. Default white. */
  loaderBackground?: string;
  /** Shown above the spinner while the page loads (an image address). Default the Baziness logo; null: none. */
  loaderIcon?: string | null;
  /** Default `#6938ef`, on a `rgba(105,56,239,.18)` track. */
  spinnerColor?: string;
  spinnerTrackColor?: string;
  /** The sheet's top corners, in pixels. Default 20. */
  cornerRadius?: number;
  /** The strip over the top of the page that holds the handle: tap it to close, or drag it down. Default 32. */
  handleStripHeight?: number;
  /** Default 96 × 4 pixels. */
  handleSize?: { width: number; height: number };
  /** Default `rgba(216,180,254,.85)`. */
  handleColor?: string;
  /**
   * Dragged further down than this part of the sheet (160 pixels at most), it closes when let go; less,
   * it springs back. Default 0.25.
   */
  dragToClose?: number;
  /** Show a close button over a page that has not loaded after this long. Default false: never, the handle always closes. */
  closeButtonAfterMs?: number | false;
}

const SLIDE_MS = 320;
const SLIDE_EASING = 'cubic-bezier(.22,.61,.36,1)';
const MAX_DRAG_TO_CLOSE_PX = 160;
/** Moved further down than this, a press on the handle is a drag, not a tap. */
const TAP_PX = 4;
const STYLE_ID = 'baziness-sheet-styles';

/** Whether letting go of the handle closes the sheet; otherwise it springs back. */
export function dragCloses(dragged: number, sheetHeight: number, dragToClose: number): boolean {
  return dragged > Math.min(MAX_DRAG_TO_CLOSE_PX, sheetHeight * dragToClose);
}

/** How much shade and blur stay over the game while the sheet is dragged down: 1 open, 0 gone. */
export function shadeFor(dragged: number, sheetHeight: number): number {
  return sheetHeight > 0 ? 1 - Math.min(1, dragged / sheetHeight) : 1;
}

/**
 * The shade's blur radius never changes: only the opacity of its one layer does, which the GPU
 * composites cheaply. Animating a blur radius re-runs the blur every frame and stutters on weak phones.
 * `--baziness-scrim` (0 to 1) follows the sheet: 1 open, 0 gone.
 */
const STYLES = `
[data-baziness-overlay]{position:fixed;inset:0;display:flex;align-items:flex-end;justify-content:center;pointer-events:auto;--baziness-scrim:0}
[data-baziness-overlay][data-open]{--baziness-scrim:1}
[data-baziness-overlay] *,[data-baziness-overlay] *::before,[data-baziness-overlay] *::after{box-sizing:border-box}
[data-baziness-shade]{position:absolute;inset:0;background:var(--bz-shade);-webkit-backdrop-filter:var(--bz-blur);backdrop-filter:var(--bz-blur);opacity:var(--baziness-scrim);transition:var(--baziness-scrim-transition,opacity ${SLIDE_MS}ms ${SLIDE_EASING});will-change:opacity;pointer-events:none}
[data-baziness-sheet]{position:relative;width:100%;max-width:var(--bz-max-width);height:var(--bz-height);border-radius:var(--bz-radius) var(--bz-radius) 0 0;background:var(--bz-backdrop);box-shadow:0 -10px 30px rgba(0,0,0,.5);overflow:hidden;transform:translateY(100%);transition:transform ${SLIDE_MS}ms ${SLIDE_EASING};will-change:transform}
[data-baziness-overlay][data-open] [data-baziness-sheet]{transform:translateY(0)}
[data-baziness-handle]{position:absolute;top:0;left:0;right:0;height:var(--bz-handle-strip);display:grid;place-items:center;margin:0;padding:0;border:0;background:transparent;cursor:grab;z-index:4;touch-action:none;-webkit-user-select:none;user-select:none;-webkit-user-drag:none;-webkit-tap-highlight-color:transparent}
[data-baziness-handle]:active{cursor:grabbing}
[data-baziness-handle]:focus:not(:focus-visible){outline:none}
[data-baziness-handle]>span{width:var(--bz-handle-w);height:var(--bz-handle-h);border-radius:999px;background:var(--bz-handle-color)}
[data-baziness-frame]{width:100%;height:100%;border:0;display:block}
[data-baziness-loader]{position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:24px;z-index:2;background:var(--bz-loader-bg)}
[data-baziness-loader]>img{width:96px;height:96px;display:block;-webkit-user-drag:none}
[data-baziness-spinner]{width:32px;height:32px;border-radius:999px;border:4px solid var(--bz-spinner-track);border-top-color:var(--bz-spinner);animation:baziness-spin .8s linear infinite}
[data-baziness-close]{position:absolute;top:40px;right:8px;width:40px;height:40px;margin:0;padding:0;border:0;border-radius:50%;background:rgba(0,0,0,.06);font:24px/40px system-ui,sans-serif;cursor:pointer;z-index:3}
@keyframes baziness-spin{to{transform:rotate(360deg)}}
@media (prefers-reduced-motion:reduce){[data-baziness-sheet],[data-baziness-shade]{transition:none}[data-baziness-spinner]{animation:none}}
`;

function ensureStyles(): void {
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement('style');
  style.id = STYLE_ID;
  style.textContent = STYLES;
  document.head.append(style);
}

function sheetHeight(topGap: number | undefined): string {
  if (topGap === undefined) return 'calc(100% - 22px)';
  const gap = Math.max(topGap, 0);
  return gap >= 1 ? `calc(100% - ${gap}px)` : `calc(${(1 - Math.min(gap, 0.9)) * 100}% - env(safe-area-inset-top, 0px))`;
}

/** One open sheet and what belongs to it. */
interface Sheet {
  id: number;
  root: HTMLDivElement;
  sheet: HTMLDivElement;
  page: HTMLDivElement;
  loader: HTMLDivElement;
  iframe: HTMLIFrameElement | null;
  closeButton: HTMLButtonElement | null;
  timers: Array<ReturnType<typeof setTimeout>>;
  onClosed: () => void;
  dragging: boolean;
}

/**
 * The in-game view of a page: a sheet that slides up over the game, which stays in view above it,
 * blurred and shaded. It opens at once with the Baziness logo and a spinner, and shows the page when
 * its address is ready and loaded. A handle strip over the top of the page closes it when tapped, and
 * the sheet follows it when dragged down — the shade lightening with it — closing when let go far
 * enough, springing back otherwise. Tapping the game or Escape closes it too. Only one is open at a time.
 */
export class PageOverlay {
  private current: Sheet | null = null;
  private nextId = 0;
  private keyHandler: ((event: KeyboardEvent) => void) | null = null;

  constructor(private readonly options: OverlayOptions = {}) {}

  get isOpen(): boolean {
    return this.current !== null;
  }

  /** The window of the open page, to check that a message comes from it. */
  get frameWindow(): Window | null {
    return this.current?.iframe?.contentWindow ?? null;
  }

  /** Slide the sheet up with its loader. Returns its id, for {@link load} once the page address is ready. */
  open(onClosed: () => void): number {
    this.close();
    ensureStyles();
    const o = this.options;
    const id = ++this.nextId;

    const root = document.createElement('div');
    root.setAttribute('data-baziness-overlay', '');
    root.setAttribute('role', 'dialog');
    root.setAttribute('aria-modal', 'true');
    root.style.zIndex = String(o.zIndex ?? 2147483000);
    const vars: Record<string, string> = {
      '--bz-shade': o.shade ?? 'rgba(15,23,42,.46)',
      '--bz-blur': o.blurGame === false ? 'none' : `blur(${o.blurPx ?? 14}px)`,
      '--bz-max-width': `${o.maxWidth ?? 480}px`,
      '--bz-height': sheetHeight(o.topGap),
      '--bz-radius': `${o.cornerRadius ?? 20}px`,
      '--bz-backdrop': o.backdrop ?? '#4c1d95',
      '--bz-handle-strip': `${o.handleStripHeight ?? 32}px`,
      '--bz-handle-w': `${o.handleSize?.width ?? 96}px`,
      '--bz-handle-h': `${o.handleSize?.height ?? 4}px`,
      '--bz-handle-color': o.handleColor ?? 'rgba(216,180,254,.85)',
      '--bz-loader-bg': o.loaderBackground ?? '#fff',
      '--bz-spinner': o.spinnerColor ?? '#6938ef',
      '--bz-spinner-track': o.spinnerTrackColor ?? 'rgba(105,56,239,.18)',
    };
    for (const [name, value] of Object.entries(vars)) root.style.setProperty(name, value);

    const shade = document.createElement('div');
    shade.setAttribute('data-baziness-shade', '');
    shade.setAttribute('aria-hidden', 'true');

    const sheet = document.createElement('div');
    sheet.setAttribute('data-baziness-sheet', '');

    const handle = document.createElement('button');
    handle.type = 'button';
    handle.setAttribute('data-baziness-handle', '');
    handle.setAttribute('aria-label', (typeof o.closeLabel === 'function' ? o.closeLabel() : o.closeLabel) || 'Close');
    handle.append(document.createElement('span'));

    const page = document.createElement('div');
    page.style.cssText = 'position:absolute;inset:0';

    const loader = document.createElement('div');
    loader.setAttribute('data-baziness-loader', '');
    loader.setAttribute('aria-hidden', 'true');
    const icon = o.loaderIcon === undefined ? BAZINESS_LOGO : o.loaderIcon;
    if (icon) {
      const logo = document.createElement('img');
      logo.src = icon;
      logo.alt = '';
      logo.width = 96;
      logo.height = 96;
      loader.append(logo);
    }
    const spinner = document.createElement('span');
    spinner.setAttribute('data-baziness-spinner', '');
    loader.append(spinner);

    page.append(loader);
    sheet.append(handle, page);
    root.append(shade, sheet);
    (o.container ?? document.body).append(root);

    const current: Sheet = {
      id,
      root,
      sheet,
      page,
      loader,
      iframe: null,
      closeButton: null,
      timers: [],
      onClosed,
      dragging: false,
    };
    this.current = current;
    // A tap on the game around the sheet; taps inside the page never reach this document.
    root.addEventListener('click', (event) => {
      if (event.target === root) this.close();
    });
    this.followDrags(current, handle);
    this.keyHandler = (event) => {
      if (event.key === 'Escape') this.close();
    };
    document.addEventListener('keydown', this.keyHandler);
    // Two frames: the sheet must be drawn below the screen first, or it appears without sliding.
    requestAnimationFrame(() =>
      requestAnimationFrame(() => {
        if (this.current === current) root.setAttribute('data-open', '');
      }),
    );
    return id;
  }

  /** Show the page in the sheet `id` (ignored when that sheet has closed since). */
  load(id: number, url: string): void {
    const current = this.current;
    if (!current || current.id !== id || current.iframe) return;
    const iframe = document.createElement('iframe');
    iframe.setAttribute('data-baziness-frame', '');
    iframe.src = url;
    iframe.title = 'Baziness';
    iframe.allow = 'clipboard-write; web-share';
    iframe.referrerPolicy = 'strict-origin-when-cross-origin';
    if (current.dragging) iframe.style.pointerEvents = 'none';
    iframe.addEventListener('load', () => {
      current.loader.remove();
      current.closeButton?.remove();
    });
    current.page.append(iframe);
    current.iframe = iframe;
    const after = this.options.closeButtonAfterMs ?? false;
    if (after !== false) {
      current.timers.push(setTimeout(() => this.showCloseButton(current), Math.max(0, after)));
    }
  }

  /** Close the open sheet, or only the sheet `id` when given. */
  close(id?: number): void {
    const current = this.current;
    if (!current || (id !== undefined && current.id !== id)) return;
    this.current = null;
    for (const timer of current.timers) clearTimeout(timer);
    if (this.keyHandler) document.removeEventListener('keydown', this.keyHandler);
    this.keyHandler = null;
    const { root, sheet } = current;
    root.style.pointerEvents = 'none'; // the game takes the next tap while the sheet slides away
    root.style.removeProperty('--baziness-scrim-transition');
    root.style.setProperty('--baziness-scrim', '0');
    root.removeAttribute('data-open');
    sheet.style.transition = '';
    sheet.style.transform = 'translateY(100%)';
    setTimeout(() => root.remove(), SLIDE_MS + 20);
    current.onClosed();
  }

  private showCloseButton(current: Sheet): void {
    if (this.current !== current || !current.loader.isConnected) return;
    const button = document.createElement('button');
    button.type = 'button';
    button.setAttribute('data-baziness-close', '');
    button.setAttribute('aria-label', current.root.querySelector('[data-baziness-handle]')?.getAttribute('aria-label') ?? 'Close');
    button.textContent = '×';
    button.addEventListener('click', () => this.close(current.id));
    current.page.append(button);
    current.closeButton = button;
  }

  /**
   * The sheet follows the handle 1:1 while pressed, and the shade fades with it. Let go further than
   * `dragToClose`, it slides the rest of the way down; less, it springs back. A press that hardly moved
   * is a tap, which the handle's click turns into a close (keyboards press it too).
   */
  private followDrags(current: Sheet, handle: HTMLButtonElement): void {
    const { root, sheet } = current;
    let pointerId: number | null = null;
    let startY = 0;
    let offset = 0;
    let height = 0;
    let moved = false;
    let suppressClick = false;
    let settle: ReturnType<typeof setTimeout> | undefined;

    const setShade = (value: number | null): void => {
      if (value === null) root.style.removeProperty('--baziness-scrim');
      else root.style.setProperty('--baziness-scrim', String(value));
    };
    const settleLater = (): void => {
      settle = setTimeout(() => {
        sheet.style.transform = '';
        setShade(null);
      }, SLIDE_MS);
      current.timers.push(settle);
    };
    const release = (event: PointerEvent): void => {
      pointerId = null;
      current.dragging = false;
      if (handle.hasPointerCapture?.(event.pointerId)) handle.releasePointerCapture(event.pointerId);
      sheet.style.transition = '';
      root.style.removeProperty('--baziness-scrim-transition');
      if (current.iframe) current.iframe.style.pointerEvents = '';
    };

    handle.addEventListener('pointerdown', (event) => {
      if (pointerId !== null || this.current !== current) return;
      clearTimeout(settle);
      pointerId = event.pointerId;
      suppressClick = false;
      moved = false;
      startY = event.clientY;
      offset = 0;
      height = sheet.offsetHeight || window.innerHeight; // read once: no reflow while dragging
      current.dragging = true;
      sheet.style.transition = 'none';
      sheet.style.transform = 'translateY(0px)';
      root.style.setProperty('--baziness-scrim-transition', 'none');
      setShade(1);
      if (current.iframe) current.iframe.style.pointerEvents = 'none';
      handle.setPointerCapture?.(event.pointerId);
    });
    handle.addEventListener('pointermove', (event) => {
      if (event.pointerId !== pointerId) return;
      const delta = event.clientY - startY;
      if (delta > TAP_PX) moved = true;
      offset = Math.max(0, delta); // only down
      sheet.style.transform = `translateY(${offset}px)`;
      setShade(shadeFor(offset, height));
    });
    handle.addEventListener('pointerup', (event) => {
      if (event.pointerId !== pointerId) return;
      release(event);
      if (!moved) {
        sheet.style.transform = ''; // a tap: the click that follows closes
        setShade(null);
        return;
      }
      suppressClick = true; // a touch drag can end in a synthetic click
      if (dragCloses(offset, height, this.options.dragToClose ?? 0.25)) {
        this.close(current.id);
        return;
      }
      sheet.style.transform = 'translateY(0px)';
      setShade(1);
      settleLater();
    });
    handle.addEventListener('pointercancel', (event) => {
      if (event.pointerId !== pointerId) return;
      release(event);
      sheet.style.transform = 'translateY(0px)';
      setShade(1);
      settleLater();
    });
    handle.addEventListener('click', () => {
      if (suppressClick) {
        suppressClick = false;
        return;
      }
      this.close(current.id);
    });
  }
}
