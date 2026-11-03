using System.Net.Http.Headers;
using System.Net.Sockets;
using System.Text;
using System.Text.Json;
using System.Text.Json.Serialization;

namespace Baziness.Server;

/// <summary>Set by the transport when an attempt's outcome was unknown (timeout, 500, 504) and the call was sent again.</summary>
internal sealed class RequestOutcome
{
    public bool ResentAfterUnknownOutcome { get; set; }
}

/// <param name="Operation">Name used in errors, logs and the circuit breaker, e.g. <c>addCoin</c>.</param>
/// <param name="Method">GET or POST.</param>
/// <param name="Path">Path under the API root, e.g. <c>/client/add-coin</c>.</param>
internal sealed record RequestSpec(string Operation, HttpMethod Method, string Path)
{
    /// <summary>Sent as camelCase JSON, with null fields left out: older hubs answer 500 to <c>"metaData": null</c>.</summary>
    public object? Body { get; init; }

    /// <summary>Send the client token (and re-authenticate once on 401).</summary>
    public bool UseClientToken { get; init; } = true;

    /// <summary>
    /// Safe to send twice. Idempotent calls are retried after timeouts and 500s; the others only when the
    /// platform certainly did not process them (429, 502, 503, connection refused).
    /// </summary>
    public bool Idempotent { get; init; }

    public RequestOutcome? Outcome { get; init; }
}

/// <summary>Supplies the client token; <c>forceNew</c> after a 401. Set by <see cref="ClientAuth"/>.</summary>
internal delegate Task<string> ClientTokenSupplier(long deadlineAt, bool forceNew, CancellationToken cancellationToken);

/// <summary>
/// The SDK's only way to the platform: timeouts, a deadline per call, bounded retries, a concurrency
/// limit, a breaker per operation and the client-token 401 dance.
/// </summary>
internal sealed class Transport(string apiBase, HttpOptions options, HttpClient http, IBazinessLogger logger)
{
    private static readonly HashSet<int> RetryableAlways = [429, 502, 503];
    private static readonly HashSet<int> RetryableIfIdempotent = [500, 504];

    // The request never left this machine, so even a non-idempotent call is safe to send again.
    private static readonly HashSet<SocketError> NotSentErrors =
        [SocketError.ConnectionRefused, SocketError.HostNotFound, SocketError.TryAgain];

    internal static readonly JsonSerializerOptions WriteOptions = new()
    {
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
        DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull
    };

    internal static readonly JsonSerializerOptions ReadOptions = new()
    {
        PropertyNameCaseInsensitive = true
    };

    private readonly int _maxAttempts = Math.Max(1, options.MaxAttempts);
    private readonly SemaphoreSlim? _slots = options.MaxConcurrent > 0 ? new SemaphoreSlim(options.MaxConcurrent) : null;
    private readonly Breaker _breaker = new(options.BreakerThreshold, options.BreakerResetMs);
    private ClientTokenSupplier? _clientToken;

    internal static long Now => Environment.TickCount64;

    public void UseClientToken(ClientTokenSupplier supplier) => _clientToken = supplier;

    /// <summary>The call's answer as JSON; default when the platform answered with nothing.</summary>
    public async Task<T?> RequestAsync<T>(RequestSpec spec, long? deadlineAt = null, CancellationToken cancellationToken = default)
    {
        var text = await SendAsync(spec, deadlineAt, cancellationToken).ConfigureAwait(false);
        if (string.IsNullOrWhiteSpace(text))
            return default;

        try
        {
            return JsonSerializer.Deserialize<T>(text, ReadOptions);
        }
        catch (JsonException e)
        {
            throw new BazinessException($"{spec.Operation}: the platform sent invalid JSON", spec.Operation, 200, innerException: e);
        }
    }

    /// <summary>The call's answer as text.</summary>
    public async Task<string> SendAsync(RequestSpec spec, long? deadlineAt = null, CancellationToken cancellationToken = default)
    {
        if (_breaker.IsOpen(spec.Operation))
            throw new BazinessException($"{spec.Operation}: platform unavailable (circuit open)", spec.Operation);

        try
        {
            var answer = await SendWithAuthAsync(spec, deadlineAt ?? Now + options.DeadlineMs, cancellationToken).ConfigureAwait(false);
            _breaker.Succeeded(spec.Operation);
            return answer;
        }
        catch (BazinessException e) when (e.IsUnavailable)
        {
            if (_breaker.Failed(spec.Operation))
                logger.Warn($"[baziness] {spec.Operation}: circuit opened after repeated failures");
            throw;
        }
    }

    private async Task<string> SendWithAuthAsync(RequestSpec spec, long deadlineAt, CancellationToken cancellationToken)
    {
        if (!spec.UseClientToken)
            return Parse(spec, await WithRetriesAsync(spec, deadlineAt, null, cancellationToken).ConfigureAwait(false));

        if (_clientToken == null)
            throw new InvalidOperationException("Transport: no client token supplier");

        var token = await _clientToken(deadlineAt, false, cancellationToken).ConfigureAwait(false);
        var answer = await WithRetriesAsync(spec, deadlineAt, token, cancellationToken).ConfigureAwait(false);
        if (answer.Status == 401)
        {
            // The client token expired or was revoked: authenticate again and retry this call once.
            token = await _clientToken(deadlineAt, true, cancellationToken).ConfigureAwait(false);
            answer = await WithRetriesAsync(spec, deadlineAt, token, cancellationToken).ConfigureAwait(false);
        }

        return Parse(spec, answer);
    }

    private static string Parse(RequestSpec spec, Answer answer)
    {
        if (answer.Status is >= 200 and < 300)
            return answer.Text;

        var code = ErrorCode(answer.Text);
        throw new BazinessException(
            $"{spec.Operation}: HTTP {answer.Status}{(code == null ? "" : $" ({code})")}",
            spec.Operation, answer.Status, code);
    }

    private async Task<Answer> WithRetriesAsync(RequestSpec spec, long deadlineAt, string? token, CancellationToken cancellationToken)
    {
        BazinessException? lastError = null;
        for (var attempt = 1; attempt <= _maxAttempts; attempt++)
        {
            TimeSpan? retryAfter = null;
            try
            {
                var answer = await OnceAsync(spec, deadlineAt, token, cancellationToken).ConfigureAwait(false);
                var retryable = RetryableAlways.Contains(answer.Status) ||
                                (spec.Idempotent && RetryableIfIdempotent.Contains(answer.Status));
                if (!retryable || attempt == _maxAttempts)
                    return answer;

                // 429, 502 and 503 mean the platform did not process it; 500 and 504 may come after it did.
                if (RetryableIfIdempotent.Contains(answer.Status) && spec.Outcome != null)
                    spec.Outcome.ResentAfterUnknownOutcome = true;

                retryAfter = answer.RetryAfter;
                lastError = new BazinessException($"{spec.Operation}: HTTP {answer.Status}", spec.Operation, answer.Status);
            }
            catch (Exception e) when (!cancellationToken.IsCancellationRequested)
            {
                lastError = ToTransportError(spec.Operation, e);
                var notSent = WasNotSent(e);
                if (!(spec.Idempotent || notSent) || attempt == _maxAttempts)
                    throw lastError;

                if (!notSent && spec.Outcome != null)
                    spec.Outcome.ResentAfterUnknownOutcome = true;
            }

            var backoff = retryAfter?.TotalMilliseconds ??
                          options.RetryBaseMs * Math.Pow(2, attempt - 1) * (0.5 + Random.Shared.NextDouble());
            if (Now + backoff >= deadlineAt)
                throw lastError;

            logger.Warn($"[baziness] {spec.Operation}: {lastError.Message}; retrying in {Math.Round(backoff)} ms");
            await Task.Delay(TimeSpan.FromMilliseconds(backoff), cancellationToken).ConfigureAwait(false);
        }

        throw lastError ?? new BazinessException($"{spec.Operation}: failed", spec.Operation);
    }

    private async Task<Answer> OnceAsync(RequestSpec spec, long deadlineAt, string? token, CancellationToken cancellationToken)
    {
        if (_slots != null &&
            !await _slots.WaitAsync(TimeSpan.FromMilliseconds(Math.Max(0, deadlineAt - Now)), cancellationToken).ConfigureAwait(false))
            throw new BazinessException($"{spec.Operation}: too many requests in flight", spec.Operation);

        try
        {
            var remaining = deadlineAt - Now;
            if (remaining <= 0)
                throw new BazinessException($"{spec.Operation}: deadline exceeded", spec.Operation);

            using var timeout = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
            timeout.CancelAfter(TimeSpan.FromMilliseconds(Math.Min(options.TimeoutMs, remaining)));

            using var request = new HttpRequestMessage(spec.Method, $"{apiBase}{spec.Path}");
            request.Headers.Accept.Add(new MediaTypeWithQualityHeaderValue("application/json"));
            if (spec.Body != null)
            {
                request.Content = new StringContent(JsonSerializer.Serialize(spec.Body, spec.Body.GetType(), WriteOptions),
                    Encoding.UTF8, "application/json");
            }

            if (token != null)
                request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", token);

            using var response = await http.SendAsync(request, timeout.Token).ConfigureAwait(false);
            var text = await response.Content.ReadAsStringAsync(timeout.Token).ConfigureAwait(false);
            return new Answer((int)response.StatusCode, text, RetryAfter(response));
        }
        finally
        {
            _slots?.Release();
        }
    }

    private static TimeSpan? RetryAfter(HttpResponseMessage response)
    {
        var delta = response.Headers.RetryAfter?.Delta;
        return delta is null ? null : TimeSpan.FromMilliseconds(Math.Min(delta.Value.TotalMilliseconds, 30000));
    }

    private static string? ErrorCode(string text)
    {
        if (string.IsNullOrEmpty(text))
            return null;

        try
        {
            using var body = JsonDocument.Parse(text);
            if (body.RootElement.ValueKind != JsonValueKind.Object)
                return null;

            foreach (var name in new[] { "error", "message", "title" })
            {
                if (body.RootElement.TryGetProperty(name, out var value) && value.ValueKind == JsonValueKind.String &&
                    !string.IsNullOrWhiteSpace(value.GetString()))
                    return value.GetString()!.Trim();
            }

            return null;
        }
        catch (JsonException)
        {
            // Not JSON: a short plain-text body is the reason itself.
            return text.Length <= 200 && !string.IsNullOrWhiteSpace(text) ? text.Trim() : null;
        }
    }

    private static bool WasNotSent(Exception error) =>
        error is HttpRequestException { InnerException: SocketException socket } &&
        NotSentErrors.Contains(socket.SocketErrorCode);

    private static BazinessException ToTransportError(string operation, Exception error)
    {
        if (error is BazinessException bazinessError)
            return bazinessError;

        var reason = error is OperationCanceledException ? "timed out" : $"network error ({error.Message})";
        return new BazinessException($"{operation}: {reason}", operation, innerException: error);
    }

    private readonly record struct Answer(int Status, string Text, TimeSpan? RetryAfter);

    /// <summary>Per-operation breaker: a degraded get-coin never blocks create-user.</summary>
    private sealed class Breaker(int threshold, int resetMs)
    {
        private readonly object _gate = new();
        private readonly Dictionary<string, int> _failures = new();
        private readonly Dictionary<string, long> _openedAt = new();

        public bool IsOpen(string operation)
        {
            if (threshold <= 0)
                return false;

            lock (_gate)
            {
                if (!_openedAt.TryGetValue(operation, out var openedAt))
                    return false;
                if (Now - openedAt < resetMs)
                    return true;

                // Half-open: this call is the probe; one more failure re-opens the breaker.
                _openedAt.Remove(operation);
                _failures[operation] = threshold - 1;
                return false;
            }
        }

        public void Succeeded(string operation)
        {
            lock (_gate)
            {
                _failures.Remove(operation);
                _openedAt.Remove(operation);
            }
        }

        /// <summary>True when this failure opened the breaker.</summary>
        public bool Failed(string operation)
        {
            if (threshold <= 0)
                return false;

            lock (_gate)
            {
                var failures = _failures.GetValueOrDefault(operation) + 1;
                _failures[operation] = failures;
                if (failures < threshold || _openedAt.ContainsKey(operation))
                    return false;

                _openedAt[operation] = Now;
                _failures[operation] = 0;
                return true;
            }
        }
    }
}
