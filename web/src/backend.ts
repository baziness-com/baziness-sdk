import type { DeviceInfo } from './device.js';
import type { Attribution } from './launch.js';

/** What the device sends your server when it needs a Baziness session. */
export interface SessionRequest {
  /** One-time code from the launch address; only on the first request after a launch. */
  linkCode?: string;
  /** First-touch attribution; your server forwards it when it creates the player. */
  attribution?: Attribution;
  device: DeviceInfo;
}

/** What your server answers: the result of `players.signIn` / `players.session` on the server SDK. */
export interface BackendSession {
  userId: number;
  isLinkedToAccount: boolean;
  /** 15-minute access token. Never a refresh token: that one stays on your server. */
  accessToken: string;
  accessTokenExpiresAt: string;
  /** The server's session id, so device events are grouped with the server's session events. */
  sessionId?: string;
  /** Anything else your server adds (for example which player this device should switch to). */
  [extra: string]: unknown;
}

/**
 * Your game server's side of the integration. The device never talks to Baziness with a secret: it
 * asks your server, which uses the server SDK. Use {@link httpBackend} for the conventional routes,
 * or implement these yourself (for example over your game's socket).
 */
export interface GameBackend {
  /** A session for the current player (`players.signIn` on your server). */
  session(request: SessionRequest): Promise<BackendSession>;
  /** A link code for opening one Baziness page (`players.linkCode` on your server). */
  linkCode(): Promise<string>;
  /** A page sent `login`: verify the token on your server (`players.verifyToken`) and link or switch. */
  login(token: string): Promise<unknown>;
  /** A page sent `logout`: end the session on your server (`players.logout`). */
  logout(): Promise<unknown>;
}

export interface HttpBackendOptions {
  /** Headers for every call, e.g. your game's own player authentication. */
  headers?: () => Record<string, string> | Promise<Record<string, string>>;
  /** `same-origin` by default; `include` when your API is on another origin and uses cookies. */
  credentials?: RequestCredentials;
  fetch?: typeof fetch;
}

/**
 * A {@link GameBackend} that calls four JSON routes under `baseUrl` on your server:
 * `POST /session`, `POST /link-code`, `POST /login`, `POST /logout` (see the server SDK recipes).
 */
export function httpBackend(baseUrl: string, options: HttpBackendOptions = {}): GameBackend {
  const base = baseUrl.replace(/\/+$/, '');
  const call = async <T>(path: string, body: unknown): Promise<T> => {
    const fetchImpl = options.fetch ?? fetch;
    const headers = { 'Content-Type': 'application/json', ...(await options.headers?.()) };
    const response = await fetchImpl(`${base}${path}`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body ?? {}),
      credentials: options.credentials ?? 'same-origin',
    });
    const text = await response.text();
    if (!response.ok) {
      throw new BackendError(`${path}: HTTP ${response.status}`, response.status, text);
    }
    return (text ? JSON.parse(text) : {}) as T;
  };
  return {
    session: (request) => call<BackendSession>('/session', request),
    linkCode: async () => {
      const answer = await call<{ linkCode?: string; code?: string }>('/link-code', {});
      const code = answer.linkCode ?? answer.code;
      if (!code) throw new BackendError('/link-code: no code in the answer', 200, '');
      return code;
    },
    login: (token) => call('/login', { token }),
    logout: () => call('/logout', {}),
  };
}

export class BackendError extends Error {
  readonly status: number;
  readonly body: string;

  constructor(message: string, status: number, body: string) {
    super(message);
    this.name = 'BackendError';
    this.status = status;
    this.body = body;
  }
}
