using UnityEngine;

namespace Baziness
{
    /// <summary>
    /// Project settings for the SDK (Assets → Create → Baziness → Settings). Nothing here is secret:
    /// the client secret lives only on your game server.
    /// </summary>
    [CreateAssetMenu(menuName = "Baziness/Settings", fileName = "BazinessSettings")]
    public sealed class BazinessSettings : ScriptableObject
    {
        [Tooltip("Staging while you integrate and test; Production after the platform team's review.")]
        public BazinessEnvironment environment = BazinessEnvironment.Staging;

        [Tooltip("Your platform package name (packageName on every page).")]
        public string packageName;

        [Tooltip("Your game name (game_name on the reward and game-offer pages).")]
        public string gameName;

        [Tooltip("Direct, GooglePlay, AppStore, CafeBazaar or Myket: where this build is published.")]
        public string store = "Direct";

        [Tooltip("Base URL of your game server's Baziness routes (/session, /link-code, /login, /logout), for HttpGameBackend.")]
        public string gameServerUrl;

        [Tooltip("How Baziness pages look while they open and load. The defaults are Yatzy's.")]
        public PageViewStyle pageView = new PageViewStyle();

        [Tooltip("Optional overrides, e.g. a local platform stack.")]
        public string apiBaseUrlOverride;
        public string pagesBaseUrlOverride;
    }
}
