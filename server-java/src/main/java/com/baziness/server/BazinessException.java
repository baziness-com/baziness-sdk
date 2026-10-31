package com.baziness.server;

/**
 * A Baziness call that failed for good (after retries). {@link #status()} is the HTTP status when the
 * platform answered (0 for network failures and timeouts), {@link #code()} the platform's error code
 * ({@code invalid_link_code}, {@code account_suspended}, …) when it sent one.
 */
public class BazinessException extends RuntimeException {
    private static final long serialVersionUID = 1L;

    public static final String INVALID_LINK_CODE = "invalid_link_code";
    public static final String ACCOUNT_SUSPENDED = "account_suspended";
    public static final String REFRESH_TOKEN_ROTATED = "refresh_token_rotated";
    /**
     * {@code coins.add}: the platform refused the payout. Your game's coin wallet may be short of coins,
     * or this transaction id was already paid by an earlier call (the platform does not say which).
     */
    public static final String ADD_COIN_REFUSED = "add_coin_refused";

    private final String operation;
    private final int status;
    private final String code;

    public BazinessException(String message, String operation, int status, String code) {
        super(message);
        this.operation = operation;
        this.status = status;
        this.code = code;
    }

    public String operation() {
        return operation;
    }

    public int status() {
        return status;
    }

    public String code() {
        return code;
    }

    /** The platform could not be reached or answered 5xx: carry on without it. */
    public boolean isUnavailable() {
        return status == 0 || status >= 500;
    }

    /** True when the platform answered with this error code. */
    public boolean hasCode(String expected) {
        return expected.equals(code);
    }
}
