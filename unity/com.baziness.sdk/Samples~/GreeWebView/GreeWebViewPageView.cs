// Baziness pages in gree's unity-webview (https://github.com/gree/unity-webview).
// Import this sample into a project that already has WebViewObject (Assets/Plugins or the UPM package).
using System;
using UnityEngine;

namespace Baziness.Samples
{
    /// <summary>
    /// Shows a page full screen in a <c>WebViewObject</c>. Pages opened with <c>sdkType=unity</c> send
    /// their messages as <c>unity:</c> navigations, which gree hands to the callback.
    /// </summary>
    public sealed class GreeWebViewPageView : MonoBehaviour, IPageView
    {
        private WebViewObject webView;
        private Action<string> onMessage;
        private Action onClosed;

        public string SdkType => "unity";
        public bool IsOpen => webView != null;

        /// <summary>A page view on its own hidden GameObject that survives scene loads.</summary>
        public static GreeWebViewPageView Create()
        {
            var host = new GameObject("BazinessPageView");
            DontDestroyOnLoad(host);
            return host.AddComponent<GreeWebViewPageView>();
        }

        public void Open(string url, Action<string> messageHandler, Action closedHandler)
        {
            Close();
            onMessage = messageHandler;
            onClosed = closedHandler;
            webView = new GameObject("BazinessWebView").AddComponent<WebViewObject>();
            webView.transform.SetParent(transform);
            webView.Init(
                cb: message => onMessage?.Invoke(message),
                err: error => Debug.LogWarning("[baziness] web view error: " + error),
                httpErr: error => Debug.LogWarning("[baziness] web view HTTP error: " + error),
                ld: _ => webView?.SetVisibility(true));
#if UNITY_EDITOR_OSX || UNITY_STANDALONE_OSX || UNITY_IOS
            // UIWebView fallback: WKWebView defines Unity.call itself.
            webView.EvaluateJS(@"if (!(window.webkit && window.webkit.messageHandlers)) {
                window.Unity = { call: function(msg) { window.location = 'unity:' + msg; } }; }");
#endif
            webView.SetMargins(0, 0, 0, 0);
            webView.SetTextZoom(100);
            webView.SetVisibility(false);
            webView.LoadURL(url);
        }

        public void Close()
        {
            if (webView == null) return;
            Destroy(webView.gameObject);
            webView = null;
            var closed = onClosed;
            onClosed = null;
            closed?.Invoke();
        }

        private void Update()
        {
            // Android back button closes the page, like its own close button.
            if (webView != null && Input.GetKeyDown(KeyCode.Escape)) Close();
        }
    }
}
