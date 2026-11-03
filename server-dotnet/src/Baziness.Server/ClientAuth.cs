using System.Text.Json;

namespace Baziness.Server;

/// <summary>
/// Step 1 of the flow: the game server proves who it is with its client id and secret and keeps the client
/// token in memory. The token is fetched on first use, renewed shortly before it expires and again whenever a
/// call answers 401. Concurrent callers share one authentication.
/// </summary>
internal sealed class ClientAuth(Transport transport, long clientId, string clientSecret)
{
    /// <summary>Renew the client token this long before the expiry written in it.</summary>
    private static readonly TimeSpan RenewBeforeExpiry = TimeSpan.FromMinutes(1);

    private readonly object _gate = new();
    private string? _token;
    private DateTimeOffset _expiresAt = DateTimeOffset.MaxValue;
    private Task<string>? _inFlight;

    public Task<string> GetAsync(long deadlineAt, bool forceNew, CancellationToken cancellationToken)
    {
        lock (_gate)
        {
            if (_token != null && !forceNew && DateTimeOffset.UtcNow < _expiresAt - RenewBeforeExpiry)
                return Task.FromResult(_token);

            // Shared, so one caller giving up does not fail the others; each waits only as long as it wants.
            _inFlight ??= Task.Run(() => AuthenticateAsync(deadlineAt));
            return _inFlight.WaitAsync(cancellationToken);
        }
    }

    private async Task<string> AuthenticateAsync(long deadlineAt)
    {
        try
        {
            var answer = await transport.RequestAsync<WireClientAuth>(new RequestSpec("clientAuth", HttpMethod.Post, "/client/auth")
            {
                Body = new { clientId, clientSecret },
                UseClientToken = false,
                Idempotent = true
            }, deadlineAt).ConfigureAwait(false);

            if (string.IsNullOrEmpty(answer?.Token))
                throw new BazinessException("clientAuth: the platform sent no token", "clientAuth", 200);

            lock (_gate)
            {
                _token = answer.Token;
                _expiresAt = Jwt.Expiry(answer.Token) ?? DateTimeOffset.MaxValue;
            }

            return answer.Token;
        }
        finally
        {
            lock (_gate)
                _inFlight = null;
        }
    }

    private sealed record WireClientAuth(string? Token);
}

internal static class Jwt
{
    /// <summary>The <c>exp</c> of a JWT, read without verifying it (the platform verifies).</summary>
    public static DateTimeOffset? Expiry(string token)
    {
        var parts = token.Split('.');
        if (parts.Length < 2)
            return null;

        try
        {
            var payload = parts[1].Replace('-', '+').Replace('_', '/');
            payload = payload.PadRight(payload.Length + (4 - payload.Length % 4) % 4, '=');
            using var claims = JsonDocument.Parse(Convert.FromBase64String(payload));
            return claims.RootElement.TryGetProperty("exp", out var exp) && exp.ValueKind == JsonValueKind.Number
                ? DateTimeOffset.FromUnixTimeSeconds(exp.GetInt64())
                : null;
        }
        catch (Exception e) when (e is FormatException or JsonException or InvalidOperationException or ArgumentOutOfRangeException)
        {
            return null;
        }
    }
}
