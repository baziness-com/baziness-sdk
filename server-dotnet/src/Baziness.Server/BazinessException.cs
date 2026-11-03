namespace Baziness.Server;

/// <summary>
/// A Baziness call that failed for good (after retries). <see cref="Status"/> is the HTTP status when the
/// platform answered, <see cref="Code"/> the platform's error code (<c>invalid_link_code</c>,
/// <c>account_suspended</c>, ...) when it sent one. Network failures and timeouts have no status.
/// </summary>
public class BazinessException(
    string message,
    string operation,
    int? status = null,
    string? code = null,
    Exception? innerException = null)
    : Exception(message, innerException)
{
    public string Operation { get; } = operation;
    public int? Status { get; } = status;
    public string? Code { get; } = code;

    /// <summary>True when the platform could not be reached or answered 5xx: the game should carry on without it.</summary>
    public bool IsUnavailable => Status is null or >= 500;
}

/// <summary>Platform error codes the SDK reacts to.</summary>
public static class BazinessErrorCodes
{
    public const string InvalidLinkCode = "invalid_link_code";
    public const string AccountSuspended = "account_suspended";

    /// <summary>
    /// <see cref="Coins.AddAsync"/>: the platform refused the payout. Your game's coin wallet may be short of
    /// coins, or this transaction id was already paid by an earlier call (the platform does not say which).
    /// </summary>
    public const string AddCoinRefused = "add_coin_refused";
}
