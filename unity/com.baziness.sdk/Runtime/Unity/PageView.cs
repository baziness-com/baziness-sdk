using System;
using UnityEngine;

namespace Baziness
{
    /// <summary>
    /// How Baziness pages are shown. Import the "gree unity-webview page view" sample for Android/iOS,
    /// or implement this over your own web view. Messages from the page are raw strings
    /// (<c>close</c>, <c>login:&lt;token&gt;</c>, … or JSON); the SDK parses them.
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
    /// Last resort: opens the page in the system browser. The page cannot send messages back, so
    /// sign-in is not linked to the player. Use a real web view in a release.
    /// </summary>
    public sealed class ExternalBrowserPageView : IPageView
    {
        public string SdkType => "unity";
        public bool IsOpen => false;

        public void Open(string url, Action<string> onMessage, Action onClosed)
        {
            Debug.LogWarning("[baziness] no web view configured: opening the page in the browser (no messages come back)");
            Application.OpenURL(url);
            onClosed?.Invoke();
        }

        public void Close()
        {
        }
    }
}
