namespace Baziness.Server;

/// <summary>
/// The two Baziness environments. A game integrates against <see cref="Staging"/> with its staging client
/// id and secret, and switches to <see cref="Production"/> (and the production keys) only after the platform
/// team has reviewed the integration. Each environment has its own credentials: they are never shared.
/// </summary>
public enum BazinessEnvironment
{
    Staging,
    Production
}

/// <param name="Api">Platform API root, including <c>/api</c>.</param>
/// <param name="Pages">Baziness pages (login, profile, shop, game offer).</param>
/// <param name="Pay">Baziness Pay.</param>
public sealed record EnvironmentUrls(string Api, string Pages, string Pay);

public static class BazinessEnvironments
{
    private static readonly EnvironmentUrls StagingUrls = new(
        "https://platform-dev.karizmastudios.org/api",
        "https://platform-web-dev.karizmastudios.org",
        "https://pay-dev.karizmastudios.org");

    private static readonly EnvironmentUrls ProductionUrls = new(
        "https://platform.karizmastudio.com/api",
        "https://baziness.com",
        "https://pay.baziness.com");

    public static EnvironmentUrls Urls(BazinessEnvironment environment) => environment switch
    {
        BazinessEnvironment.Staging => StagingUrls,
        BazinessEnvironment.Production => ProductionUrls,
        _ => throw new ArgumentException($"BazinessServer: unknown environment \"{environment}\"", nameof(environment))
    };

    /// <summary>Reads <c>staging</c> or <c>production</c>.</summary>
    public static BazinessEnvironment Parse(string value) => value.Trim() switch
    {
        "staging" => BazinessEnvironment.Staging,
        "production" => BazinessEnvironment.Production,
        _ => throw new ArgumentException($"BAZINESS_ENVIRONMENT must be \"staging\" or \"production\", got \"{value}\"", nameof(value))
    };
}
