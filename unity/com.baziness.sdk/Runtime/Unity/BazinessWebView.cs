using System;
using System.Collections;
using UnityEngine;
using UnityEngine.EventSystems;
using UnityEngine.UI;

namespace Baziness
{
    /// <summary>How the built-in page view looks. The defaults are Yatzy's; layout values are in canvas units.</summary>
    [Serializable]
    public sealed class PageViewStyle
    {
        [Tooltip("The sheet behind the page while it loads and slides in.")]
        public Color backdrop = Color.white;
        [Tooltip("Over the game, above the sheet.")]
        public Color shade = new Color(0f, 0f, 0f, 0.35f);
        [Tooltip("The game shows blurred above the sheet (a still of the screen when the page opens).")]
        public bool blurGame = true;
        [Tooltip("The game left in view above the sheet, as a part of the screen height.")]
        [Range(0f, 0.3f)]
        public float topGap = 0.06f;
        [Tooltip("The top of the sheet with the handle: tap it to close, or drag it down.")]
        public float handleStripHeight = 110;
        public Vector2 handleSize = new Vector2(220, 22);
        public Color handleColor = new Color(0.8f, 0.8f, 0.84f);
        [Tooltip("The sheet's top corners.")]
        public float cornerRadius = 56;
        [Tooltip("Dragged further down than this part of the sheet, it closes when let go; less, it springs back.")]
        [Range(0.05f, 0.9f)]
        public float dragToClose = 0.25f;
        [Tooltip("Shown while the page loads; empty for the SDK's.")]
        public Sprite spinner;
        public Color spinnerColor = new Color(0.396f, 0.294f, 1f);
        public float spinnerSize = 300;
        [Tooltip("Appears when a page loads slowly, so the player is never stuck; empty for the SDK's.")]
        public Sprite closeIcon;
        public float closeButtonSize = 120;
        [Tooltip("From the sheet's top-right corner.")]
        public Vector2 closeButtonPosition = new Vector2(-198, -245);
        public float closeButtonDelay = 3f;
        [Tooltip("A page that has not loaded by then shows the retry button.")]
        public float loadTimeoutSeconds = 20f;
        [Tooltip("Shown, with the close button, when the page could not load; empty for the SDK's.")]
        public Sprite retryIcon;
        public float retryButtonSize = 260;
        [Tooltip("The slide in, easing out: it moves at once and settles.")]
        public float openSeconds = 0.3f;
        [Tooltip("The slide out, easing in.")]
        public float closeSeconds = 0.25f;
        public Vector2 referenceResolution = new Vector2(1920, 1080);
        public int sortingOrder = 9999;
    }

    /// <summary>
    /// The SDK's page view: the page in the bundled web view (gree unity-webview) on a sheet that slides up
    /// over the game, which stays in view above it, blurred and shaded. A handle tops the sheet: tapping it or
    /// the game closes the page, and so does dragging it down (dragged a little, it springs back). A spinner
    /// while the page loads, a close button when it loads slowly, a retry button when it cannot load (no
    /// blank page in its place), and the Android back button. It appears the moment a page is asked for and
    /// starts the web view while your server makes the link code. Works on Android, iOS and macOS (the editor
    /// too); elsewhere the SDK opens pages in the system browser (<see cref="IsSupported"/>).
    /// </summary>
    public sealed class BazinessWebView : MonoBehaviour, IInstantPageView
    {
        private const string SpritesPath = "BazinessWebView/";

        private PageViewStyle style;
        private RectTransform canvasRect;
        private CanvasGroup shade;
        private RawImage gameStill;
        private RectTransform sheet;
        private RectTransform spinner;
        private GameObject closeButton;
        private GameObject retryButton;
        private WebViewObject webView;
        private RenderTexture blurred;
        private Action<string> onMessage;
        private Action onClosed;
        private string pageUrl;
        private bool opening;
        private bool pageRequested;
        private bool loaded;
        private bool failed;
        private bool closing;
        private bool dragging;
        private float dragOffset;
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

        /// <summary>Appear now with the spinner; the web view starts up while your server makes the link code.</summary>
        public void ShowLoading(Action closedHandler)
        {
            if (IsOpen)
                return;
            onClosed = closedHandler;
            onMessage = null;
            pageRequested = false;
            loaded = false;
            failed = false;
            closing = false;
            dragging = false;
            dragOffset = 0;
            webView = CreateWebView();

            spinner.gameObject.SetActive(true);
            closeButton.SetActive(false);
            retryButton.SetActive(false);
            loadingSince = Time.unscaledTime;
            StopAllCoroutines();
            StartCoroutine(SlideIn());
        }

        public void Open(string url, Action<string> messageHandler, Action closedHandler)
        {
            if (closing)
                return;
            if (!IsOpen)
                ShowLoading(closedHandler);
            onMessage = messageHandler;
            onClosed = closedHandler;
            pageRequested = true;
            pageUrl = url;
            Load();
        }

        public void Close()
        {
            if (webView == null || closing)
                return;
            closing = true;
            dragging = false;
            StopAllCoroutines();
            StartCoroutine(SlideOut());
        }

        private void Load()
        {
            failed = false;
            loaded = false;
            loadingSince = Time.unscaledTime;
            spinner.gameObject.SetActive(true);
            retryButton.SetActive(false);
            closeButton.SetActive(false);
            webView.LoadURL(pageUrl);
        }

        private WebViewObject CreateWebView()
        {
            var view = new GameObject("WebViewObject").AddComponent<WebViewObject>();
            view.transform.SetParent(transform, false);
#if UNITY_EDITOR_OSX || UNITY_STANDALONE_OSX
            // macOS draws the page into this canvas.
            view.canvas = gameObject;
            view.bitmapRefreshCycle = 1;
#endif
            view.Init(
                cb: message => onMessage?.Invoke(message),
                err: OnLoadError,
                httpErr: error => Debug.LogWarning("[baziness] page HTTP error: " + error),
                ld: _ => OnLoaded());
#if UNITY_EDITOR_OSX || UNITY_STANDALONE_OSX || UNITY_IOS
            // UIWebView fallback: WKWebView defines Unity.call itself.
            view.EvaluateJS(@"if (!(window.webkit && window.webkit.messageHandlers)) {
                window.Unity = { call: function(msg) { window.location = 'unity:' + msg; } }; }");
#endif
            view.SetTextZoom(100);
            view.SetVisibility(false);
            return view;
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

            // Over the whole game: the shade colour, and above the sheet the game's still, blurred. It takes the
            // touches while a page is up, so the game gets none, and a tap on it closes the page. The still covers
            // only the gap above the sheet: as the sheet slides away the game itself shows, not a picture of it
            // from when the page opened.
            var shadeRoot = NewImage("Shade", transform, null, Color.clear);
            Stretch(shadeRoot.rectTransform);
            shadeRoot.gameObject.AddComponent<Button>().onClick.AddListener(Close);
            shade = shadeRoot.gameObject.AddComponent<CanvasGroup>();
            gameStill = new GameObject("GameStill", typeof(RectTransform)).AddComponent<RawImage>();
            gameStill.transform.SetParent(shadeRoot.transform, false);
            gameStill.raycastTarget = false;
            var gap = Mathf.Clamp01(style.topGap);
            gameStill.rectTransform.anchorMin = new Vector2(0, 1f - gap);
            gameStill.rectTransform.anchorMax = Vector2.one;
            gameStill.rectTransform.offsetMin = gameStill.rectTransform.offsetMax = Vector2.zero;
            gameStill.uvRect = new Rect(0, 1f - gap, 1, gap);
            var tint = NewImage("Tint", shadeRoot.transform, null, style.shade);
            tint.raycastTarget = false;
            Stretch(tint.rectTransform);
            shadeRoot.gameObject.SetActive(false);

            var corner = Mathf.Max(1f, style.cornerRadius);
            var sheetImage = NewImage("Sheet", transform, RoundedSprite(Mathf.CeilToInt(corner), true), style.backdrop);
            sheetImage.type = Image.Type.Sliced;
            sheet = sheetImage.rectTransform;
            Stretch(sheet);
            sheet.gameObject.SetActive(false);

            var strip = NewImage("Handle", sheet, null, Color.clear).rectTransform;
            strip.anchorMin = new Vector2(0, 1);
            strip.anchorMax = Vector2.one;
            strip.pivot = new Vector2(0.5f, 1);
            strip.sizeDelta = new Vector2(0, style.handleStripHeight);
            strip.gameObject.AddComponent<SheetHandle>().Owner = this;
            var bar = NewImage("Bar", strip, RoundedSprite(Mathf.CeilToInt(corner), false), style.handleColor);
            bar.type = Image.Type.Sliced;
            bar.pixelsPerUnitMultiplier = corner / Mathf.Max(1f, style.handleSize.y / 2f);
            bar.raycastTarget = false;
            bar.rectTransform.sizeDelta = style.handleSize;

            spinner = NewImage("Spinner", sheet, style.spinner ? style.spinner : LoadSprite("spinner"), style.spinnerColor).rectTransform;
            spinner.sizeDelta = Vector2.one * style.spinnerSize;

            var close = NewImage("CloseButton", sheet, style.closeIcon ? style.closeIcon : LoadSprite("close"), Color.white);
            close.rectTransform.anchorMin = close.rectTransform.anchorMax = Vector2.one;
            close.rectTransform.anchoredPosition = style.closeButtonPosition;
            close.rectTransform.sizeDelta = Vector2.one * style.closeButtonSize;
            close.gameObject.AddComponent<Button>().onClick.AddListener(Close);
            closeButton = close.gameObject;

            var retry = NewImage("RetryButton", sheet, style.retryIcon ? style.retryIcon : RetrySprite(), style.spinnerColor);
            retry.rectTransform.sizeDelta = Vector2.one * style.retryButtonSize;
            retry.gameObject.AddComponent<Button>().onClick.AddListener(() =>
            {
                if (webView != null && !closing && pageRequested)
                    Load();
            });
            retryButton = retry.gameObject;
            retryButton.SetActive(false);
        }

        private void Update()
        {
            if (webView == null || closing)
                return;
            if (!loaded && !failed)
            {
                spinner.Rotate(0, 0, -360f * Time.unscaledDeltaTime); // a turn a second
                if (!closeButton.activeSelf && Time.unscaledTime - loadingSince > style.closeButtonDelay)
                    closeButton.SetActive(true);
                if (pageRequested && Time.unscaledTime - loadingSince > style.loadTimeoutSeconds)
                    Fail("no answer in " + style.loadTimeoutSeconds + " s");
            }
#if ENABLE_LEGACY_INPUT_MANAGER
            // The Android back button closes the page, like its own close button.
            if (Input.GetKeyDown(KeyCode.Escape))
                Close();
#endif
        }

        private void OnLoaded()
        {
            // Before Open the web view has no page yet: a load then is not the page. After an error, Android
            // still reports its error page as loaded.
            if (webView == null || closing || !pageRequested || failed)
                return;
            loaded = true;
            ShowPage();
        }

        private void OnLoadError(string error)
        {
            Debug.LogWarning("[baziness] page error: " + error);
            // iOS reports cancelled redirects as errors too: the page is still on its way.
            if (error != null && (error.IndexOf("cancel", StringComparison.OrdinalIgnoreCase) >= 0 || error.Contains("-999")))
                return;
            if (!loaded && pageRequested)
                Fail(error);
        }

        /// <summary>The page could not load: the retry and close buttons instead of a blank web view.</summary>
        private void Fail(string reason)
        {
            if (webView == null || closing || failed)
                return;
            Debug.LogWarning("[baziness] page not loaded: " + reason);
            failed = true;
            webView.SetVisibility(false);
            spinner.gameObject.SetActive(false);
            retryButton.SetActive(true);
            closeButton.SetActive(true);
        }

        private void ShowPage()
        {
            if (!loaded || failed || opening || webView == null)
                return;
            spinner.gameObject.SetActive(false);
            closeButton.SetActive(false);
            retryButton.SetActive(false);
            PlaceWebView();
            webView.SetVisibility(true);
        }

        // The sheet's top, below the game left in view, in canvas units.
        private float SheetTop()
        {
            return Height() * Mathf.Clamp01(style.topGap);
        }

        private float PixelsPerUnit()
        {
            return Height() > 0 ? Screen.height / Height() : 1f;
        }

        /// <summary>The page under the handle, moved down with the sheet (it keeps its height).</summary>
        private void PlaceWebView()
        {
            var scale = PixelsPerUnit();
            var top = Mathf.RoundToInt((SheetTop() + style.handleStripHeight) * scale);
            var offset = Mathf.RoundToInt(dragOffset * scale);
            webView.SetMargins(0, top + offset, 0, -offset);
        }

        private void PlaceSheet(float offset)
        {
            dragOffset = Mathf.Max(0f, offset);
            sheet.offsetMin = new Vector2(0, -dragOffset);
            sheet.offsetMax = new Vector2(0, -SheetTop() - dragOffset);
            shade.alpha = 1f - Mathf.Clamp01(dragOffset / Mathf.Max(1f, Height() - SheetTop()));
            if (webView != null && webView.GetVisibility())
                PlaceWebView();
        }

        private void OnHandleTap()
        {
            if (!dragging)
                Close();
        }

        private void OnHandleDrag(float deltaUnits)
        {
            if (webView == null || closing || opening)
                return;
            dragging = true;
            PlaceSheet(dragOffset - deltaUnits);
        }

        private void OnHandleRelease(float velocityUnits)
        {
            if (!dragging || webView == null || closing)
                return;
            dragging = false;
            // A flick down closes it as well as a long drag.
            if (dragOffset > (Height() - SheetTop()) * style.dragToClose || velocityUnits < -2000f)
                Close();
            else
                StartCoroutine(SpringBack());
        }

        private IEnumerator SpringBack()
        {
            var from = dragOffset;
            for (var elapsed = 0f; elapsed < style.openSeconds; elapsed += Time.unscaledDeltaTime)
            {
                if (dragging)
                    yield break;
                PlaceSheet(Mathf.Lerp(from, 0f, EaseOutCubic(elapsed / style.openSeconds)));
                yield return null;
            }
            PlaceSheet(0f);
        }

        private IEnumerator SlideIn()
        {
            opening = true;
            if (style.blurGame)
                yield return CaptureGame();
            shade.gameObject.SetActive(true);
            sheet.gameObject.SetActive(true);
            var travel = Height() - SheetTop();
            for (var elapsed = 0f; elapsed < style.openSeconds; elapsed += Time.unscaledDeltaTime)
            {
                PlaceSheet(travel * (1f - EaseOutCubic(elapsed / style.openSeconds)));
                yield return null;
            }
            PlaceSheet(0f);
            opening = false;
            ShowPage();
        }

        /// <summary>The sheet, with the page on it, slides down from where it is; the shade fades.</summary>
        private IEnumerator SlideOut()
        {
            var from = dragOffset;
            var to = Height();
            for (var elapsed = 0f; elapsed < style.closeSeconds; elapsed += Time.unscaledDeltaTime)
            {
                PlaceSheet(Mathf.Lerp(from, to, EaseInCubic(elapsed / style.closeSeconds)));
                yield return null;
            }
            Finish();
        }

        private void Finish()
        {
            Destroy(webView.gameObject);
            webView = null;
            shade.gameObject.SetActive(false);
            sheet.gameObject.SetActive(false);
            gameStill.texture = null;
            if (blurred != null)
            {
                blurred.Release();
                Destroy(blurred);
                blurred = null;
            }
            dragOffset = 0;
            closing = false;
            opening = false;
            var closed = onClosed;
            onClosed = null;
            closed?.Invoke();
        }

        /// <summary>A still of the game, blurred by halving it down to a sixteenth and stretching it back.</summary>
        private IEnumerator CaptureGame()
        {
            yield return new WaitForEndOfFrame();
            Texture2D shot = null;
            try
            {
                shot = ScreenCapture.CaptureScreenshotAsTexture();
                Texture source = shot;
                RenderTexture previous = null;
                int width = shot.width, height = shot.height;
                for (var step = 0; step < 4; step++)
                {
                    width = Mathf.Max(4, width / 2);
                    height = Mathf.Max(4, height / 2);
                    var next = new RenderTexture(width, height, 0) { filterMode = FilterMode.Bilinear };
                    Graphics.Blit(source, next);
                    if (previous != null)
                    {
                        previous.Release();
                        Destroy(previous);
                    }
                    previous = next;
                    source = next;
                }
                blurred = previous;
                gameStill.texture = blurred;
                gameStill.color = Color.white;
            }
            catch (Exception error)
            {
                Debug.LogWarning("[baziness] no still of the game: " + error.Message);
                gameStill.texture = null;
                gameStill.color = Color.clear;
            }
            finally
            {
                if (shot != null)
                    Destroy(shot);
            }
        }

        private float Height()
        {
            return canvasRect.rect.height > 0 ? canvasRect.rect.height : Screen.height;
        }

        private static void Stretch(RectTransform rect)
        {
            rect.anchorMin = Vector2.zero;
            rect.anchorMax = Vector2.one;
            rect.offsetMin = Vector2.zero;
            rect.offsetMax = Vector2.zero;
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

        /// <summary>A white rounded rectangle to slice: all four corners round, or the top two only.</summary>
        private static Sprite RoundedSprite(int radius, bool topOnly)
        {
            var size = radius * 2 + 2;
            var texture = new Texture2D(size, size, TextureFormat.RGBA32, false);
            var pixels = new Color32[size * size];
            for (var y = 0; y < size; y++)
            for (var x = 0; x < size; x++)
            {
                var covered = 0;
                for (var sy = 0; sy < 4; sy++)
                for (var sx = 0; sx < 4; sx++)
                {
                    var px = x + (sx + 0.5f) / 4f;
                    var py = y + (sy + 0.5f) / 4f;
                    var cx = Mathf.Clamp(px, radius, size - radius);
                    var cy = Mathf.Clamp(py, topOnly ? 0 : radius, size - radius);
                    if ((px - cx) * (px - cx) + (py - cy) * (py - cy) <= radius * radius)
                        covered++;
                }
                pixels[y * size + x] = new Color32(255, 255, 255, (byte)(covered * 255 / 16));
            }
            texture.SetPixels32(pixels);
            texture.Apply();
            var border = new Vector4(radius, topOnly ? 1 : radius, radius, radius);
            return Sprite.Create(texture, new Rect(0, 0, size, size), new Vector2(0.5f, 0.5f), 100, 0, SpriteMeshType.FullRect, border);
        }

        // A circular arrow (refresh), drawn once: white on clear, tinted by the image colour.
        private static Sprite RetrySprite()
        {
            const int size = 128;
            const float outer = 52f, inner = 38f, arrow = 20f;
            var texture = new Texture2D(size, size, TextureFormat.RGBA32, false);
            var pixels = new Color32[size * size];
            var tipAngle = 120f * Mathf.Deg2Rad; // the arc runs clockwise from 60° to 120°, the gap at the top
            var middle = (outer + inner) / 2f;
            var at = new Vector2(Mathf.Cos(tipAngle), Mathf.Sin(tipAngle)) * middle;
            var along = new Vector2(Mathf.Sin(tipAngle), -Mathf.Cos(tipAngle));
            var across = new Vector2(Mathf.Cos(tipAngle), Mathf.Sin(tipAngle));
            var a = at + across * arrow;
            var b = at - across * arrow;
            var c = at + along * arrow * 1.3f;
            for (var y = 0; y < size; y++)
            for (var x = 0; x < size; x++)
            {
                var covered = 0;
                for (var sy = 0; sy < 4; sy++)
                for (var sx = 0; sx < 4; sx++)
                {
                    var p = new Vector2(x + (sx + 0.5f) / 4f - size / 2f, y + (sy + 0.5f) / 4f - size / 2f);
                    var r = p.magnitude;
                    var angle = Mathf.Atan2(p.y, p.x) * Mathf.Rad2Deg;
                    var onRing = r >= inner && r <= outer && (angle < 60f || angle > 120f);
                    if (onRing || InTriangle(p, a, b, c))
                        covered++;
                }
                pixels[y * size + x] = new Color32(255, 255, 255, (byte)(covered * 255 / 16));
            }
            texture.SetPixels32(pixels);
            texture.Apply();
            return Sprite.Create(texture, new Rect(0, 0, size, size), new Vector2(0.5f, 0.5f));
        }

        private static bool InTriangle(Vector2 p, Vector2 a, Vector2 b, Vector2 c)
        {
            float Side(Vector2 p1, Vector2 p2, Vector2 p3) => (p1.x - p3.x) * (p2.y - p3.y) - (p2.x - p3.x) * (p1.y - p3.y);
            var d1 = Side(p, a, b);
            var d2 = Side(p, b, c);
            var d3 = Side(p, c, a);
            var negative = d1 < 0 || d2 < 0 || d3 < 0;
            var positive = d1 > 0 || d2 > 0 || d3 > 0;
            return !(negative && positive);
        }

        private static float EaseOutCubic(float t)
        {
            var inverse = 1f - Mathf.Clamp01(t);
            return 1f - inverse * inverse * inverse;
        }

        private static float EaseInCubic(float t)
        {
            t = Mathf.Clamp01(t);
            return t * t * t;
        }

        /// <summary>The sheet's handle strip: a tap closes the page; a drag moves the sheet.</summary>
        [AddComponentMenu("")]
        private sealed class SheetHandle : MonoBehaviour, IPointerClickHandler, IBeginDragHandler, IDragHandler, IEndDragHandler
        {
            internal BazinessWebView Owner;
            private float velocity;

            public void OnPointerClick(PointerEventData eventData)
            {
                if (!eventData.dragging)
                    Owner.OnHandleTap();
            }

            public void OnBeginDrag(PointerEventData eventData)
            {
                velocity = 0;
            }

            public void OnDrag(PointerEventData eventData)
            {
                var units = eventData.delta.y / Owner.PixelsPerUnit();
                if (Time.unscaledDeltaTime > 0)
                    velocity = Mathf.Lerp(velocity, units / Time.unscaledDeltaTime, 0.5f);
                Owner.OnHandleDrag(units);
            }

            public void OnEndDrag(PointerEventData eventData)
            {
                Owner.OnHandleRelease(velocity);
            }
        }
    }
}
