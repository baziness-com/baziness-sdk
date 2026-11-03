using System.Globalization;
using System.Security.Cryptography;
using System.Text;

namespace Baziness.Server;

/// <param name="Credited">Coins credited by this call (the platform answers with the amount, not the balance); null when already credited.</param>
/// <param name="AlreadyCredited">
/// An attempt of this call reached the platform without an answer (timeout, 500) and the platform refused the
/// retry as already applied: treat it as paid.
/// </param>
/// <param name="TransactionId">The payout's transaction id.</param>
public sealed record AddCoinsResult(long? Credited, bool AlreadyCredited, string TransactionId);

/// <summary>Gita coins (step 4): give coins to your players and read their balance.</summary>
public sealed class Coins
{
    private readonly Transport _transport;

    internal Coins(Transport transport)
    {
        _transport = transport;
    }

    /// <summary>
    /// Credit coins. <paramref name="grantKey"/> says what this payout <b>is</b> (<c>match:17</c>,
    /// <c>reward_claim:42</c>, <c>tutorial_gift</c>): the same payout always gives the same transaction id, so a
    /// retry, a double tap or a crash never pays twice. <paramref name="metadata"/> (any JSON-serializable value:
    /// the source, match id, ...) is stored with the transaction, for reports.
    /// <para>
    /// The platform answers every refusal alike (<c>add resource failed</c>: wallet short of coins, id already
    /// paid, ...). When this call had sent the payout before without an answer, a refusal means the first attempt
    /// was applied: <see cref="AddCoinsResult.AlreadyCredited"/>. Otherwise it throws
    /// <see cref="BazinessErrorCodes.AddCoinRefused"/>: nothing was paid by this call, so do not show the coins.
    /// </para>
    /// </summary>
    public Task<AddCoinsResult> AddAsync(long userId, long amount, string grantKey, object? metadata = null,
        CancellationToken cancellationToken = default)
    {
        if (string.IsNullOrEmpty(grantKey))
            throw new ArgumentException("coins.add: pass grantKey so the payout cannot be paid twice", nameof(grantKey));

        return AddWithTransactionIdAsync(userId, amount, TransactionIdFor(userId, amount, grantKey), metadata, cancellationToken);
    }

    /// <summary>Like <see cref="AddAsync"/> with your own unique id for this payout.</summary>
    public async Task<AddCoinsResult> AddWithTransactionIdAsync(long userId, long amount, string transactionId,
        object? metadata = null, CancellationToken cancellationToken = default)
    {
        if (amount <= 0)
            throw new ArgumentOutOfRangeException(nameof(amount), "coins.add: amount must be a positive integer");
        if (string.IsNullOrEmpty(transactionId))
            throw new ArgumentException("coins.add: transactionId is required", nameof(transactionId));

        var outcome = new RequestOutcome();
        try
        {
            var answer = await _transport.RequestAsync<WireResource>(new RequestSpec("addCoin", HttpMethod.Post, "/client/add-coin")
            {
                Body = new { userId, amount, transactionId, metaData = metadata },
                Idempotent = true,
                Outcome = outcome
            }, cancellationToken: cancellationToken).ConfigureAwait(false);

            return new AddCoinsResult(answer?.Amount, false, transactionId);
        }
        catch (BazinessException e) when (e.Status == 400 &&
                                          (e.Code ?? "").Contains("add resource failed", StringComparison.OrdinalIgnoreCase))
        {
            if (outcome.ResentAfterUnknownOutcome)
                return new AddCoinsResult(null, true, transactionId);

            throw new BazinessException(
                $"coins.add: the platform refused the payout (add resource failed): your coin wallet may be short of coins, or transaction {transactionId} was paid by an earlier call",
                "addCoin", 400, BazinessErrorCodes.AddCoinRefused, e);
        }
    }

    /// <summary>A player's Gita coin balance.</summary>
    public async Task<long> BalanceAsync(long userId, CancellationToken cancellationToken = default)
    {
        var answer = await _transport.RequestAsync<WireResource>(
            new RequestSpec("getCoin", HttpMethod.Get, $"/client/get-coin/{userId}") { Idempotent = true },
            cancellationToken: cancellationToken).ConfigureAwait(false);

        return answer?.Amount ?? 0;
    }

    /// <summary><c>userId_amount_first 24 hex chars of sha1(grantKey)</c>, the platform's convention.</summary>
    public static string TransactionIdFor(long userId, long amount, string grantKey)
    {
        var digest = Convert.ToHexString(SHA1.HashData(Encoding.UTF8.GetBytes(grantKey))).ToLowerInvariant();
        return string.Create(CultureInfo.InvariantCulture, $"{userId}_{amount}_{digest[..24]}");
    }

    private sealed record WireResource(long Amount);
}
