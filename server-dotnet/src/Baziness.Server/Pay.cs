using System.Globalization;
using System.Text.Json;

namespace Baziness.Server;

/// <summary>A payment the player completed on the Baziness Pay checkout page and your game has not consumed yet.</summary>
/// <param name="PlayerId">Your player id (Pay's <c>uid</c>).</param>
/// <param name="Sku">The package.</param>
/// <param name="Token">The payment's token: what your server checks with <see cref="Pay.VerifyAsync"/> and keeps to grant it once.</param>
/// <param name="TransactionId">Pay's transaction id.</param>
/// <param name="Amount">What the player paid, in Toman.</param>
/// <param name="PackageTitle">The package's title in Pay.</param>
/// <param name="Gateway">The bank gateway behind the checkout (<c>zarinpal</c>, <c>tara</c>, <c>snappPay</c>, ...).</param>
/// <param name="SubmittedAt">When it was submitted, as Pay wrote it.</param>
public sealed record BazinessPayment(
    long PlayerId,
    string Sku,
    string Token,
    string? TransactionId,
    decimal? Amount,
    string? PackageTitle,
    string? Gateway,
    string? SubmittedAt);

/// <summary>
/// Baziness Pay: the web checkout (<c>pay.baziness.com</c>) for packages registered in Pay under your app's package
/// name. Report each payment you granted like any other: <see cref="Purchases.RecordAsync"/> with gateway
/// <see cref="PaymentGateway.BazinessPay"/> and the payment's token as the order id.
/// <para>
/// The flow: the device opens the checkout page, the player pays and comes back to the game, taps "Complete
/// purchase", the device finds the payment and sends its token to your server. Your server checks it with
/// <see cref="VerifyAsync"/>, grants the package once per token, then calls <see cref="ConsumeAsync"/> so the player
/// can buy the same package again.
/// </para>
/// </summary>
public sealed class Pay
{
    /// <summary>Pay's answer when there is no such payment (not paid, not yet reported by the gateway, or consumed).</summary>
    private const string NotValid = "payment_is_not_valid";

    private readonly Transport _transport;

    internal Pay(Transport transport, string packageName)
    {
        if (string.IsNullOrWhiteSpace(packageName))
            throw new ArgumentException("pay: packageName is required (your app in Baziness Pay)", nameof(packageName));

        _transport = transport;
        PackageName = packageName;
    }

    /// <summary>Your app's package name in Baziness Pay (Pay's <c>pname</c>).</summary>
    public string PackageName { get; }

    /// <summary>
    /// The player's paid, unconsumed payment for this package, or null when there is none: not paid yet, still on
    /// the bank's page, or already consumed. A server can complete a checkout with this alone, without a token from
    /// the device.
    /// </summary>
    public async Task<BazinessPayment?> FindAsync(long playerId, string sku, CancellationToken cancellationToken = default)
    {
        var answer = await CallAsync("payFind", "/get_payment", new { uid = playerId, sku, pname = PackageName }, null, cancellationToken)
            .ConfigureAwait(false);
        if (!answer.Success)
            return NotValidOrThrow<BazinessPayment?>(answer, "payFind", null);
        if (string.IsNullOrEmpty(answer.Token))
            throw new BazinessException("pay.find: Baziness Pay sent a payment without a token", "payFind", 200);

        return new BazinessPayment(answer.Uid ?? playerId, answer.Sku ?? sku, answer.Token, answer.TransactionId,
            answer.Amount, answer.PackageTitle, answer.Gateway, answer.SubmittedAt);
    }

    /// <summary>
    /// True when <paramref name="token"/> is a payment of this player for this package that is paid and not consumed
    /// yet. A paid payment must carry exactly this token (Pay itself would accept any token while one is paid). When
    /// none is paid yet, Pay checks the token with the bank: a payment whose gateway callback was lost.
    /// </summary>
    public async Task<bool> VerifyAsync(long playerId, string sku, string token, CancellationToken cancellationToken = default)
    {
        if (string.IsNullOrWhiteSpace(token))
            return false;

        var payment = await FindAsync(playerId, sku, cancellationToken).ConfigureAwait(false);
        if (payment != null)
            return payment.Token == token;

        var answer = await CallAsync("payVerify", "/verify_payment", new { uid = playerId, sku, pname = PackageName, token }, null, cancellationToken)
            .ConfigureAwait(false);
        return answer.Success || NotValidOrThrow(answer, "payVerify", false);
    }

    /// <summary>
    /// Marks the paid payment of this package as delivered, so the player can buy it again. Call it after your grant
    /// is saved. False when there was nothing to consume (already consumed).
    /// </summary>
    public async Task<bool> ConsumeAsync(long playerId, string sku, CancellationToken cancellationToken = default)
    {
        var outcome = new RequestOutcome();
        var answer = await CallAsync("payConsume", "/consume", new { uid = playerId, sku, pname = PackageName }, outcome, cancellationToken)
            .ConfigureAwait(false);
        if (answer.Success)
            return true;

        // An attempt reached Pay without an answer and the retry found nothing left: the first one consumed it.
        if (answer.Error == NotValid && outcome.ResentAfterUnknownOutcome)
            return true;

        return NotValidOrThrow(answer, "payConsume", false);
    }

    private async Task<PayAnswer> CallAsync(string operation, string path, object body, RequestOutcome? outcome, CancellationToken cancellationToken)
    {
        // Every Pay call is safe to repeat: two reads, and a consume that finds nothing the second time.
        var text = await _transport.SendAsync(new RequestSpec(operation, HttpMethod.Post, path)
        {
            Body = body,
            UseClientToken = false,
            Idempotent = true,
            Outcome = outcome
        }, cancellationToken: cancellationToken).ConfigureAwait(false);

        try
        {
            return PayAnswer.Parse(text);
        }
        catch (JsonException e)
        {
            throw new BazinessException($"{operation}: Baziness Pay sent invalid JSON", operation, 200, innerException: e);
        }
    }

    /// <summary><c>payment_is_not_valid</c> is an answer (the fallback); any other Pay error (unknown app, <c>unexpected</c>) throws.</summary>
    private static T NotValidOrThrow<T>(PayAnswer answer, string operation, T fallback)
    {
        if (answer.Error == NotValid)
            return fallback;

        var code = answer.Error ?? "unexpected";
        var hint = code == "no_required_params" ? " (is the package name registered in Baziness Pay?)" : "";
        throw new BazinessException($"{operation}: Baziness Pay answered {code}{hint}", operation, 200, code);
    }

    /// <summary>Baziness Pay's answers: HTTP 200 with <c>success</c>, plus the payment or an <c>error</c> code.</summary>
    private sealed record PayAnswer
    {
        public bool Success { get; private init; }
        public string? Error { get; private init; }
        public long? Uid { get; private init; }
        public string? Sku { get; private init; }
        public string? Token { get; private init; }
        public string? TransactionId { get; private init; }
        public decimal? Amount { get; private init; }
        public string? PackageTitle { get; private init; }
        public string? Gateway { get; private init; }
        public string? SubmittedAt { get; private init; }

        public static PayAnswer Parse(string text)
        {
            if (string.IsNullOrWhiteSpace(text))
                return new PayAnswer();

            using var document = JsonDocument.Parse(text);
            var root = document.RootElement;
            if (root.ValueKind != JsonValueKind.Object)
                return new PayAnswer();

            return new PayAnswer
            {
                Success = root.TryGetProperty("success", out var success) && success.ValueKind == JsonValueKind.True,
                Error = Text(root, "error"),
                Uid = long.TryParse(Text(root, "uid"), CultureInfo.InvariantCulture, out var uid) ? uid : null,
                Sku = Text(root, "sku"),
                Token = Text(root, "token"),
                TransactionId = Text(root, "transactionId"),
                Amount = decimal.TryParse(Text(root, "amount"), CultureInfo.InvariantCulture, out var amount) ? amount : null,
                PackageTitle = Text(root, "packageTitle"),
                Gateway = Text(root, "gateway"),
                SubmittedAt = Text(root, "submittedAt")
            };
        }

        /// <summary>Pay's fields as text, whichever JSON type it sent them in.</summary>
        private static string? Text(JsonElement root, string name)
        {
            if (!root.TryGetProperty(name, out var value))
                return null;

            return value.ValueKind switch
            {
                JsonValueKind.String => value.GetString(),
                JsonValueKind.Number => value.GetRawText(),
                _ => null
            };
        }
    }
}
