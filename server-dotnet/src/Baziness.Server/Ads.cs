namespace Baziness.Server;

/// <summary>The sponsor ad assigned to this game. Fetching it does not count an impression.</summary>
public sealed record Ad(long Id, string Title, string ImageUrl, string Link);

/// <summary>Sponsor ads and their views/clicks, authenticated with the game's client token. Server only.</summary>
public sealed class Ads
{
    private readonly Transport _transport;

    internal Ads(Transport transport) => _transport = transport;

    /// <summary>The game's current ad, or null when none is assigned (204 or JSON null).</summary>
    public async Task<Ad?> GetAsync(CancellationToken cancellationToken = default)
    {
        var ad = await _transport.RequestAsync<Ad>(new RequestSpec("getAd", HttpMethod.Get, "/content/get-ad")
        {
            Idempotent = true
        }, cancellationToken: cancellationToken).ConfigureAwait(false);
        if (ad != null && (ad.Id <= 0 || ad.Title == null || ad.ImageUrl == null || ad.Link == null))
            throw new BazinessException("getAd: the platform sent an invalid ad", "getAd", 200);
        return ad;
    }

    /// <summary>Call once when the player sees this ad. userId is the Baziness user id, not the game's id.</summary>
    public Task SeenAsync(long adId, long userId, CancellationToken cancellationToken = default) =>
        TrackAsync(adId, userId, "seen", cancellationToken);

    /// <summary>Call once when the player clicks the ad they were shown.</summary>
    public Task ClickAsync(long adId, long userId, CancellationToken cancellationToken = default) =>
        TrackAsync(adId, userId, "click", cancellationToken);

    private async Task TrackAsync(long adId, long userId, string eventType, CancellationToken cancellationToken)
    {
        if (adId <= 0) throw new ArgumentOutOfRangeException(nameof(adId));
        if (userId <= 0) throw new ArgumentOutOfRangeException(nameof(userId));
        // Counts events: do not replay an uncertain outcome (timeout, 500, 504).
        await _transport.SendAsync(new RequestSpec("trackAdEvent", HttpMethod.Post, "/content/ad-event")
        {
            Body = new { adId, userId, eventType },
            Idempotent = false
        }, cancellationToken: cancellationToken).ConfigureAwait(false);
    }
}
