/** `staging` while you integrate and test; `production` after the platform team's review. */
export type BazinessEnvironment = 'staging' | 'production';

export interface EnvironmentUrls {
  /** Platform API root, including `/api`. */
  api: string;
  /** Baziness pages. Messages from a page are accepted only from this origin. */
  pages: string;
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
