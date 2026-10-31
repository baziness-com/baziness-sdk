using System;
using System.Collections;
using UnityEngine;
using UnityEngine.UI;

namespace Baziness
{
    /// <summary>How the built-in page view looks. The defaults are Yatzy's; layout values are in canvas units.</summary>
    [Serializable]
    public sealed class PageViewStyle
    {
        [Tooltip("Behind the page while it loads and slides in.")]
        public Color backdrop = Color.white;
        [Tooltip("Shown while the page loads; empty for the SDK's.")]
        public Sprite spinner;
        public Color spinnerColor = new Color(0.396f, 0.294f, 1f);
        public float spinnerSize = 300;
        [Tooltip("Appears when a page loads slowly, so the player is never stuck; empty for the SDK's.")]
        public Sprite closeIcon;
        public float closeButtonSize = 120;
        [Tooltip("From the top-right corner.")]
        public Vector2 closeButtonPosition = new Vector2(-198, -245);
        public float closeButtonDelay = 3f;
        public float openSeconds = 0.45f;
        public float closeSeconds = 0.4f;
        public Vector2 referenceResolution = new Vector2(1920, 1080);
        public int sortingOrder = 9999;
    }

    /// <summary>
    /// The SDK's page view: the page in the bundled web view (gree unity-webview) over a backdrop that
    /// slides up, a spinner while it loads, a close button when it loads slowly, a slide-down on close and
    /// the Android back button. Works on Android, iOS and macOS (the editor too); elsewhere the SDK opens
    /// pages in the system browser (<see cref="IsSupported"/>).
    /// </summary>
    public sealed class BazinessWebView : MonoBehaviour, IPageView
    {
        private const string SpritesPath = "BazinessWebView/";

        private PageViewStyle style;
        private RectTransform canvasRect;
        private RectTransform backdrop;
        private RectTransform spinner;
        private GameObject closeButton;
        private WebViewObject webView;
        private Action<string> onMessage;
        private Action onClosed;
        private bool opening;
        private bool loaded;
        private bool closing;
        private float loadingSince;

        public string SdkType => "unity";
        public bool IsOpen => webView != null;

        /// <summary>The bundled web view works here; elsewhere pages open in the system browser.</summary>
        public static bool IsSupported
        {
            get
            {
#if UNITY_EDITOR_WIN || UNITY_EDITOR_LINUX
                return false;
#elif UNITY_ANDROID || UNITY_IOS || UNITY_STANDALONE_OSX || UNITY_EDITOR_OSX
                return true;
#else
                return false;
#endif
            }
        }

        /// <summary>A page view on its own canvas that survives scene loads.</summary>
        public static BazinessWebView Create(PageViewStyle style = null)
        {
            var host = new GameObject("BazinessWebView");
            DontDestroyOnLoad(host);
            var view = host.AddComponent<BazinessWebView>();
            view.Build(style ?? new PageViewStyle());
            return view;
        }

        public void Open(string url, Action<string> messageHandler, Action closedHandler)
        {
            if (IsOpen)
                return;
            onMessage = messageHandler;
            onClosed = closedHandler;
            loaded = false;
            closing = false;

            webView = new GameObject("WebViewObject").AddComponent<WebViewObject>();
            webView.transform.SetParent(transform, false);
#if UNITY_EDITOR_OSX || UNITY_STANDALONE_OSX
            // macOS draws the page into this canvas.
            webView.canvas = gameObject;
            webView.bitmapRefreshCycle = 1;
#endif
            webView.Init(
                cb: message => onMessage?.Invoke(message),
                err: OnLoadError,
                httpErr: error => Debug.LogWarning("[baziness] page HTTP error: " + error),
                ld: _ => OnLoaded());
#if UNITY_EDITOR_OSX || UNITY_STANDALONE_OSX || UNITY_IOS
            // UIWebView fallback: WKWebView defines Unity.call itself.
            webView.EvaluateJS(@"if (!(window.webkit && window.webkit.messageHandlers)) {
                window.Unity = { call: function(msg) { window.location = 'unity:' + msg; } }; }");
#endif
            webView.SetMargins(0, 0, 0, 0);
            webView.SetTextZoom(100);
            webView.SetVisibility(false);
            webView.LoadURL(url);

            spinner.gameObject.SetActive(true);
            closeButton.SetActive(false);
            backdrop.gameObject.SetActive(true);
            loadingSince = Time.unscaledTime;
            StopAllCoroutines();
            StartCoroutine(SlideIn());
        }

        public void Close()
        {
            if (webView == null || closing)
                return;
            closing = true;
            StopAllCoroutines();
            StartCoroutine(webView.GetVisibility() ? SlidePageOut() : SlideBackdropOut());
        }

        private void Build(PageViewStyle pageStyle)
        {
            style = pageStyle;
            var canvas = gameObject.AddComponent<Canvas>();
            canvas.renderMode = RenderMode.ScreenSpaceOverlay;
            canvas.sortingOrder = style.sortingOrder;
            var scaler = gameObject.AddComponent<CanvasScaler>();
            scaler.uiScaleMode = CanvasScaler.ScaleMode.ScaleWithScreenSize;
            scaler.referenceResolution = style.referenceResolution;
            scaler.matchWidthOrHeight = 0;
            gameObject.AddComponent<GraphicRaycaster>();
            canvasRect = (RectTransform)transform;

            // The backdrop takes the touches while a page is up, so the game below gets none.
            backdrop = NewImage("Backdrop", transform, null, style.backdrop).rectTransform;
            backdrop.anchorMin = Vector2.zero;
            backdrop.anchorMax = Vector2.one;
            backdrop.sizeDelta = Vector2.zero;

            spinner = NewImage("Spinner", backdrop, style.spinner ? style.spinner : LoadSprite("spinner"), style.spinnerColor).rectTransform;
            spinner.sizeDelta = Vector2.one * style.spinnerSize;

            var close = NewImage("CloseButton", backdrop, style.closeIcon ? style.closeIcon : LoadSprite("close"), Color.white);
            close.rectTransform.anchorMin = close.rectTransform.anchorMax = Vector2.one;
            close.rectTransform.anchoredPosition = style.closeButtonPosition;
            close.rectTransform.sizeDelta = Vector2.one * style.closeButtonSize;
            close.gameObject.AddComponent<Button>().onClick.AddListener(Close);
            closeButton = close.gameObject;

            backdrop.gameObject.SetActive(false);
        }

        private void Update()
        {
            if (webView == null || closing)
                return;
            if (!loaded)
            {
                spinner.Rotate(0, 0, -360f * Time.unscaledDeltaTime); // a turn a second
                if (!closeButton.activeSelf && Time.unscaledTime - loadingSince > style.closeButtonDelay)
                    closeButton.SetActive(true);
            }
#if ENABLE_LEGACY_INPUT_MANAGER
            // The Android back button closes the page, like its own close button.
            if (Input.GetKeyDown(KeyCode.Escape))
                Close();
#endif
        }

        private void OnLoaded()
        {
            if (webView == null || closing)
                return;
            loaded = true;
            ShowPage();
        }

        private void OnLoadError(string error)
        {
            Debug.LogWarning("[baziness] page error: " + error);
            // Not closed by itself: iOS reports cancelled redirects as errors too. The player can close it.
            if (!loaded && closeButton != null)
                closeButton.SetActive(true);
        }

        private void ShowPage()
        {
            if (!loaded || opening || webView == null)
                return;
            spinner.gameObject.SetActive(false);
            closeButton.SetActive(false);
            webView.SetVisibility(true);
        }

        private IEnumerator SlideIn()
        {
            opening = true;
            yield return Slide(backdrop, -Height() * 1.5f, 0, style.openSeconds, EaseInOutQuint);
            opening = false;
            ShowPage();
        }

        /// <summary>A loading page: the backdrop slides down.</summary>
        private IEnumerator SlideBackdropOut()
        {
            webView.SetVisibility(false);
            yield return Slide(backdrop, backdrop.anchoredPosition.y, -Height() * 1.8f, style.closeSeconds, EaseOutExpo);
            Finish();
        }

        /// <summary>A loaded page: the web view itself slides down.</summary>
        private IEnumerator SlidePageOut()
        {
            backdrop.gameObject.SetActive(false);
            for (var elapsed = 0f; elapsed < style.closeSeconds; elapsed += Time.unscaledDeltaTime)
            {
                var t = EaseOutExpo(elapsed / style.closeSeconds);
                webView.SetMargins(0, (int)Mathf.Lerp(0, Screen.height + 200, t), 0, (int)Mathf.Lerp(0, -Screen.height + 200, t));
                yield return null;
            }
            Finish();
        }

        private void Finish()
        {
            Destroy(webView.gameObject);
            webView = null;
            backdrop.gameObject.SetActive(false);
            backdrop.anchoredPosition = Vector2.zero;
            closing = false;
            var closed = onClosed;
            onClosed = null;
            closed?.Invoke();
        }

        private static IEnumerator Slide(RectTransform target, float fromY, float toY, float seconds, Func<float, float> ease)
        {
            for (var elapsed = 0f; elapsed < seconds; elapsed += Time.unscaledDeltaTime)
            {
                target.anchoredPosition = new Vector2(0, Mathf.Lerp(fromY, toY, ease(elapsed / seconds)));
                yield return null;
            }
            target.anchoredPosition = new Vector2(0, toY);
        }

        private float Height()
        {
            return canvasRect.rect.height > 0 ? canvasRect.rect.height : Screen.height;
        }

        private static Image NewImage(string name, Transform parent, Sprite sprite, Color color)
        {
            var image = new GameObject(name, typeof(RectTransform)).AddComponent<Image>();
            image.transform.SetParent(parent, false);
            image.sprite = sprite;
            image.color = color;
            return image;
        }

        private static Sprite LoadSprite(string name)
        {
            var texture = Resources.Load<Texture2D>(SpritesPath + name);
            return texture == null ? null
                : Sprite.Create(texture, new Rect(0, 0, texture.width, texture.height), new Vector2(0.5f, 0.5f));
        }

        private static float EaseInOutQuint(float t)
        {
            return t < 0.5f ? 16f * t * t * t * t * t : 1f - Mathf.Pow(-2f * t + 2f, 5f) / 2f;
        }

        private static float EaseOutExpo(float t)
        {
            return t >= 1 ? 1 : 1 - Mathf.Pow(2, -10 * t);
        }
    }
}
