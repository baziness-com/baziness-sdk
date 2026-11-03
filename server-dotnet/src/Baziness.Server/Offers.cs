using System.Text.Json;

namespace Baziness.Server;

/// <summary>Personal offers from the Baziness offer engine: which shop bundle to show a player now.</summary>
public sealed class Offers
{
    private readonly Transport _transport;

    internal Offers(Transport transport)
    {
        _transport = transport;
    }

    /// <summary>
    /// The bundle to offer this player, or null when there is none now. <paramref name="playerId"/> is <b>your</b>
    /// player id, the one the offer engine was set up with for your game (not the Baziness user id).
    /// </summary>
    public async Task<int?> GetAsync(long playerId, CancellationToken cancellationToken = default)
    {
        var answer = await _transport.RequestAsync<JsonElement>(new RequestSpec("getOffer", HttpMethod.Post, "/client/get-user-offer")
        {
            Body = new { user_id = playerId },
            Idempotent = true
        }, cancellationToken: cancellationToken).ConfigureAwait(false);

        return answer.ValueKind == JsonValueKind.Object &&
               answer.TryGetProperty("bundle_id", out var bundleId) &&
               bundleId.ValueKind == JsonValueKind.Number
            ? bundleId.GetInt32()
            : null;
    }
}
