namespace Baziness.Server;

/// <summary>Baziness missions: advance a quest for one player.</summary>
public sealed class Quests
{
    private readonly Transport _transport;

    internal Quests(Transport transport)
    {
        _transport = transport;
    }

    /// <summary>
    /// Adds <paramref name="count"/> to the player's progress on the quest of this event (<c>game/event</c> for your
    /// own quests, <c>baziness/event</c> for platform-wide ones). <b>Not idempotent</b>: call it once per real event,
    /// never in a retry loop of your own.
    /// </summary>
    public async Task ProgressAsync(long userId, string questEventName, int count = 1, CancellationToken cancellationToken = default)
    {
        await _transport.SendAsync(new RequestSpec("progressQuest", HttpMethod.Post, "/lottery/progress-quest")
        {
            Body = new { userId, questEventName, progressCount = count },
            Idempotent = false
        }, cancellationToken: cancellationToken).ConfigureAwait(false);
    }
}
