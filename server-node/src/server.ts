import { ServerAnalytics, type AnalyticsOptions } from './analytics.js';
import { ClientAuth } from './clientAuth.js';
import { Coins } from './coins.js';
import { ENVIRONMENTS, isEnvironment, resolveApiBase, type BazinessEnvironment } from './environment.js';
import { silentLogger, Transport, type FetchLike, type HttpOptions, type Logger } from './http.js';
import { Players } from './players.js';
import { Purchases } from './purchases.js';
import type { RefreshTokenStore } from './types.js';
import type { WireOffer } from './wire.js';

export const SDK_VERSION = '1.3.0';

export interface BazinessServerOptions {
  /** `staging` while you integrate and test; `production` after the platform team's review. */
  environment: BazinessEnvironment;
  /** Client id of this environment. */
  clientId: number;
  /** Client secret of this environment. **Server only**: never in a client build, a log or git. */
  clientSecret: string;
  /**
   * Not needed since 1.1: your server keeps no player token. Pass the store of a 1.0 integration
   * and `players.logout` ends the sessions left in it.
   */
  refreshTokens?: RefreshTokenStore;
  /** Override the API root (a local platform stack, for example). */
  apiBaseUrl?: string;
  http?: HttpOptions;
  analytics?: AnalyticsOptions;
  /** Default: silent. Pass `console` or your logger. The SDK never logs secrets or tokens. */
  logger?: Logger;
  /** Default: the global `fetch` (Node 18+). */
  fetch?: FetchLike;
}

/** Settings that are safe to send to the device SDK. */
export interface PublicConfig {
  environment: BazinessEnvironment;
  apiUrl: string;
  pagesUrl: string;
  payUrl: string;
}

/**
 * The Baziness SDK for game servers. One instance per process; it is safe to share.
 *
 * ```ts
 * const baziness = BazinessServer.fromEnv(process.env, { logger: console });
 * const session = await baziness.players.signIn({ deviceId, platform: 'Web', store: 'Direct', userId, linkCode });
 * ```
 */
export class BazinessServer {
  readonly environment: BazinessEnvironment;
  readonly players: Players;
  readonly coins: Coins;
  readonly purchases: Purchases;
  readonly analytics: ServerAnalytics;
  readonly quests: Quests;
  readonly offers: Offers;

  private readonly apiBase: string;

  constructor(options: BazinessServerOptions) {
    if (!isEnvironment(options.environment)) {
      throw new TypeError(`BazinessServer: environment must be "staging" or "production", got "${options.environment}"`);
    }
    if (!Number.isSafeInteger(options.clientId) || options.clientId <= 0) {
      throw new TypeError('BazinessServer: clientId must be the positive client id of this environment');
    }
    if (!options.clientSecret?.trim()) {
      throw new TypeError('BazinessServer: clientSecret is required');
    }
    const logger = options.logger ?? silentLogger;
    const fetchImpl = options.fetch ?? (globalThis.fetch as FetchLike | undefined);
    if (!fetchImpl) {
      throw new TypeError('BazinessServer: no fetch available; use Node 18+ or pass `fetch`');
    }
    this.environment = options.environment;
    this.apiBase = resolveApiBase(options.environment, options.apiBaseUrl);
    if (options.environment === 'production' && options.apiBaseUrl) {
      logger.warn(`[baziness] production with an API override: ${this.apiBase}`);
    }

    const transport = new Transport(this.apiBase, options.http ?? {}, fetchImpl, logger);
    const clientAuth = new ClientAuth(transport, options.clientId, options.clientSecret);
    transport.useClientToken((deadlineAt, forceNew) => clientAuth.get(deadlineAt, forceNew));

    this.analytics = new ServerAnalytics(transport, logger, options.analytics);
    this.players = new Players(transport, options.refreshTokens, this.analytics, logger);
    this.coins = new Coins(transport);
    this.purchases = new Purchases(transport, this.analytics);
    this.quests = new Quests(transport);
    this.offers = new Offers(transport);
  }

  /**
   * Reads `BAZINESS_ENVIRONMENT` (`staging` | `production`), `BAZINESS_CLIENT_ID`,
   * `BAZINESS_CLIENT_SECRET` and optionally `BAZINESS_API_BASE_URL`.
   */
  static fromEnv(
    env: Record<string, string | undefined>,
    options: Omit<BazinessServerOptions, 'environment' | 'clientId' | 'clientSecret' | 'apiBaseUrl'> = {},
  ): BazinessServer {
    const environment = (env.BAZINESS_ENVIRONMENT ?? 'staging').trim();
    if (!isEnvironment(environment)) {
      throw new TypeError(`BAZINESS_ENVIRONMENT must be "staging" or "production", got "${environment}"`);
    }
    const serverOptions: BazinessServerOptions = {
      ...options,
      environment,
      clientId: Number.parseInt(env.BAZINESS_CLIENT_ID ?? '', 10),
      clientSecret: env.BAZINESS_CLIENT_SECRET ?? '',
    };
    const apiBaseUrl = env.BAZINESS_API_BASE_URL?.trim();
    if (apiBaseUrl) serverOptions.apiBaseUrl = apiBaseUrl;
    return new BazinessServer(serverOptions);
  }

  /** What the device SDK needs to know about this environment; nothing secret. */
  publicConfig(): PublicConfig {
    const urls = ENVIRONMENTS[this.environment];
    return { environment: this.environment, apiUrl: this.apiBase, pagesUrl: urls.pages, payUrl: urls.pay };
  }

  /** Ends open sessions and sends the remaining analytics. Call it on shutdown. */
  async close(timeoutMs = 5000): Promise<void> {
    await this.analytics.close(timeoutMs);
  }
}

/** Baziness missions: advance a quest for one player. */
export class Quests {
  constructor(private readonly transport: Transport) {}

  /**
   * Adds `count` to the player's progress on the quest of this event (`<game>/<event>` for your own
   * quests, `baziness/<event>` for platform-wide ones). **Not idempotent**: call it once per real
   * event, never in a retry loop of your own.
   */
  async progress(userId: number, questEventName: string, count = 1): Promise<void> {
    await this.transport.request<void>({
      operation: 'progressQuest',
      method: 'POST',
      path: '/lottery/progress-quest',
      body: { userId, questEventName, progressCount: count },
      auth: 'client',
      idempotent: false,
      expectJson: false,
    });
  }
}

/** Personal offers from the Baziness offer engine: which shop bundle to show a player now. */
export class Offers {
  constructor(private readonly transport: Transport) {}

  /**
   * The bundle to offer this player, or null when there is none now. `playerId` is **your** player
   * id, the one the offer engine was set up with for your game (not the Baziness user id).
   */
  async get(playerId: number): Promise<number | null> {
    const answer = await this.transport.request<WireOffer>({
      operation: 'getOffer',
      method: 'POST',
      path: '/client/get-user-offer',
      body: { user_id: playerId },
      auth: 'client',
      idempotent: true,
    });
    return typeof answer?.bundle_id === 'number' ? answer.bundle_id : null;
  }
}
