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
