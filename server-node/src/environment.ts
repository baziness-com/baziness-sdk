/**
 * The two Baziness environments. A game integrates against **staging** with its staging client id
 * and secret, and switches to **production** (and the production keys) only after the platform team
 * has reviewed the integration. Each environment has its own credentials: they are never shared.
 */
export type BazinessEnvironment = 'staging' | 'production';

export interface EnvironmentUrls {
  /** Platform API root, including `/api`. */
  api: string;
  /** Baziness pages (login, profile, shop, game offer). */
  pages: string;
  /** Baziness Pay. */
  pay: string;
}

export const ENVIRONMENTS: Readonly<Record<BazinessEnvironment, EnvironmentUrls>> = Object.freeze({
  staging: {
    api: 'https://platform-dev.karizmastudios.org/api',
    pages: 'https://platform-web-dev.karizmastudios.org',
    pay: 'https://pay-dev.karizmastudios.org',
  },
  production: {
    api: 'https://platform.karizmastudio.com/api',
    pages: 'https://baziness.com',
    pay: 'https://pay.baziness.com',
  },
});

export function isEnvironment(value: unknown): value is BazinessEnvironment {
  return value === 'staging' || value === 'production';
}

/** The API root for an environment, or the override (a local stack, for example) when one is given. */
export function resolveApiBase(environment: BazinessEnvironment, override?: string): string {
  const base = override?.trim() || ENVIRONMENTS[environment].api;
  return base.replace(/\/+$/, '');
}
