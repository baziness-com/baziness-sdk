using System;
using UnityEngine;

namespace Baziness
{
    /// <summary>
    /// How Baziness pages are shown. The SDK has its own (<see cref="BazinessWebView"/>, the bundled gree
    /// unity-webview); implement this only to show pages your own way. Messages from the page are raw
    /// strings (<c>close</c>, <c>login:&lt;token&gt;</c>, … or JSON); the SDK parses them.
    /// </summary>
    public interface IPageView
    {
        /// <summary><c>unity</c> when the page talks through <c>unity:</c> navigations (native web views), <c>js</c> for postMessage.</summary>
        string SdkType { get; }
        bool IsOpen { get; }
        void Open(string url, Action<string> onMessage, Action onClosed);
        void Close();
    }

    /// <summary>
    /// A page view that can appear before the page address is ready. <see cref="BazinessSdk.OpenPage"/> shows
    /// it at once (loading) while it gets the link code from your server, then calls <see cref="IPageView.Open"/>
    /// on it, or <see cref="IPageView.Close"/> when that fails.
    /// </summary>
    public interface IInstantPageView : IPageView
    {
        /// <summary>Appear now, loading. <paramref name="onClosed"/> runs if the player closes it before the page opens.</summary>
        void ShowLoading(Action onClosed);
    }

    /// <summary>
    /// Where the bundled web view does not run (Windows, Linux, WebGL): the page opens in the system
    /// browser. It cannot send messages back, so a sign-in there is not linked to the player.
    /// </summary>
    public sealed class ExternalBrowserPageView : IPageView
    {
        public string SdkType => "unity";
        public bool IsOpen => false;

        public void Open(string url, Action<string> onMessage, Action onClosed)
        {
            Debug.LogWarning("[baziness] no web view on this platform: opening the page in the browser (no messages come back)");
            Application.OpenURL(url);
            onClosed?.Invoke();
        }

        public void Close()
        {
        }
    }
}
