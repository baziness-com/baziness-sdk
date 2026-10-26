using System.Collections.Generic;
using UnityEngine;
using UnityEngine.UI;

namespace Baziness.Samples
{
    /// <summary>
    /// The whole device side in one component: start the SDK, show the Gita coin balance, open the
    /// reward page and report a gameplay event. Your game server provides the four routes of
    /// <see cref="HttpGameBackend"/> with the server SDK.
    /// </summary>
    public sealed class BazinessQuickStart : MonoBehaviour
    {
        [SerializeField] private BazinessSettings settings;
        [SerializeField] private Text balanceLabel;
        [Tooltip("Your game's own player token, sent to your server with every Baziness route.")]
        [SerializeField] private string gamePlayerToken;

        private async void Start()
        {
            var backend = new HttpGameBackend(new UnityHttp(), settings.gameServerUrl,
                () => new Dictionary<string, string> { ["Authorization"] = "Bearer " + gamePlayerToken });
            BazinessSdk.Initialize(settings, backend /*, GreeWebViewPageView.Create() once the gree sample is imported */);
            BazinessSdk.PageClosed += _ => RefreshBalance();
            BazinessSdk.LoggedOut += () => Debug.Log("Signed out on a page: clear local player data and start over");

            try
            {
                var session = await BazinessSdk.StartAsync();
                Debug.Log($"Baziness user {session.UserId}, linked: {session.IsLinkedToAccount}");
                RefreshBalance();
            }
            catch (System.Exception error)
            {
                // The game keeps working without Baziness: hide its UI and carry on.
                Debug.LogWarning("Baziness unavailable: " + error.Message);
            }
        }

        public void OnRewardsButton()
        {
            _ = BazinessSdk.OpenPage(BazinessPage.Shop);
        }

        public void OnLevelComplete(int level, int score)
        {
            BazinessSdk.Analytics.LevelComplete(level.ToString(), score);
        }

        private async void RefreshBalance()
        {
            try
            {
                balanceLabel.text = (await BazinessSdk.GetCoinBalanceAsync()).ToString("N0");
            }
            catch (System.Exception)
            {
                balanceLabel.text = "—";
            }
        }
    }
}
