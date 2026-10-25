namespace Baziness
{
    /// <summary>
    /// The two Baziness environments. Integrate against <see cref="Staging"/> with your staging keys;
    /// switch to <see cref="Production"/> (and the production keys on your server) after the platform
    /// team's review.
    /// </summary>
    public enum BazinessEnvironment
    {
        Staging,
        Production
    }

    public static class BazinessUrls
    {
        public static string Api(BazinessEnvironment environment)
        {
            return environment == BazinessEnvironment.Production
                ? "https://platform.karizmastudio.com/api"
                : "https://platform-dev.karizmastudios.org/api";
        }

        /// <summary>Baziness pages. Messages from a page are accepted only from this origin.</summary>
        public static string Pages(BazinessEnvironment environment)
        {
            return environment == BazinessEnvironment.Production
                ? "https://baziness.com"
                : "https://platform-web-dev.karizmastudios.org";
        }
    }
}
