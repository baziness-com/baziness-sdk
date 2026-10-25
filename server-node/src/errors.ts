/**
 * A Baziness call that failed for good (after retries). `status` is the HTTP status when the platform
 * answered, `code` the platform's error code (`invalid_link_code`, `account_suspended`, …) when it
 * sent one. Network failures and timeouts have no status.
 */
export class BazinessError extends Error {
  readonly operation: string;
  readonly status: number | undefined;
  readonly code: string | undefined;

  constructor(message: string, operation: string, status?: number, code?: string) {
    super(message);
    this.name = 'BazinessError';
    this.operation = operation;
    this.status = status;
    this.code = code;
  }

  /** True when the platform could not be reached or answered 5xx: the game should carry on without it. */
  get isUnavailable(): boolean {
    return this.status === undefined || this.status >= 500;
  }
}

/** Platform error codes the SDK reacts to. */
export const ErrorCodes = Object.freeze({
  invalidLinkCode: 'invalid_link_code',
  accountSuspended: 'account_suspended',
  refreshTokenRotated: 'refresh_token_rotated',
  sessionRevoked: 'session_revoked',
  refreshTokenExpired: 'refresh_token_expired',
  invalidRefreshToken: 'invalid_refresh_token',
  refreshTokenReused: 'refresh_token_reused',
});
