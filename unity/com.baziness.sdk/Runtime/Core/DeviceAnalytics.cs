using System;
using System.Collections.Generic;
using System.Text.RegularExpressions;
using System.Threading.Tasks;

namespace Baziness
{
    /// <summary>Where a purchase is paid: a store, your own gateway (<c>Direct</c>), or Baziness Pay.</summary>
    public enum PurchaseGateway
    {
        CafeBazaar,
        Myket,
        GooglePlay,
        AppStore,
        Direct,
        BazinessPay
    }

    /// <summary>Why a purchase did not complete.</summary>
    public enum PurchaseFailure
    {
        Cancelled,
        Error,
        Pending
    }

    /// <summary>
    /// Player analytics from the device: one method per event Baziness analytics knows (the purchase
    /// funnel, ads, onboarding, levels, in-game currency), sent with the player's 15-minute token to
    /// <c>analytics/events/batch</c>. Queued in storage so a crash or going offline loses
    /// nothing; sent every 30 s, at 100 events and when the app goes to the background (call
    /// <see cref="Tick"/> regularly and <see cref="Flush"/> on pause); retried with backoff.
    /// </summary>
    public sealed class DeviceAnalytics
    {
        /// <summary>Only the game server may report these (they are refused from devices).</summary>
        public static readonly HashSet<string> ServerOnlyEvents = new HashSet<string>
        {
            "session_start", "session_heartbeat", "session_end", "device_info", "iap_purchase_completed", "auth_login"
        };

        public static readonly Regex EventName = new Regex("^[a-z0-9_:.\\-]{1,128}$");
        private const int MaxBatch = 100;
        private static readonly TimeSpan[] Backoff =
            { TimeSpan.FromSeconds(5), TimeSpan.FromSeconds(30), TimeSpan.FromMinutes(2), TimeSpan.FromMinutes(5) };

        private readonly IHttp http;
        private readonly string apiBase;
        private readonly Func<bool, Task<string>> token;
        private readonly IQueueStorage storage;
        private readonly Func<DateTime> clock;
        private readonly int maxQueueSize;
        private readonly TimeSpan flushInterval;
        private List<object> queue;
        private Task sending;
        private DateTime retryAt = DateTime.MinValue;
        private DateTime nextFlush;
        private int failures;

        public bool Enabled = true;
        public string SessionId;
        public string AppVersion;
        /// <summary>Warnings (dropped events); <c>Debug.LogWarning</c> in the game.</summary>
        public Action<string> Warn = _ => { };

        public DeviceAnalytics(IHttp http, string apiBase, Func<bool, Task<string>> token, IQueueStorage storage,
            Func<DateTime> utcClock = null, int maxQueueSize = 1000, double flushIntervalSeconds = 30)
        {
            this.http = http;
            this.apiBase = apiBase.TrimEnd('/');
            this.token = token;
            this.storage = storage;
            clock = utcClock ?? (() => DateTime.UtcNow);
            this.maxQueueSize = maxQueueSize;
            flushInterval = TimeSpan.FromSeconds(flushIntervalSeconds);
            nextFlush = clock() + flushInterval;
            queue = Load();
        }

        public int Pending => queue.Count;

        // ── The events Baziness analytics knows (admin panel: Growth → Events) ──
        // Each returns false when the event was dropped (analytics disabled).

        /// <summary>The player tapped buy (<c>iap_purchase_started</c>). The completion comes from your server or Baziness Pay.</summary>
        public bool PurchaseStarted(string sku, double price, PurchaseGateway gateway)
        {
            return Record("iap_purchase_started", price,
                new Dictionary<string, object> { ["sku"] = sku, ["gateway"] = GatewayName(gateway) });
        }

        /// <summary>The purchase was cancelled or failed (<c>iap_purchase_failed</c>).</summary>
        public bool PurchaseFailed(string sku, PurchaseGateway gateway, PurchaseFailure reason)
        {
            return Record("iap_purchase_failed", null, new Dictionary<string, object>
            {
                ["sku"] = sku, ["gateway"] = GatewayName(gateway), ["reason"] = reason.ToString().ToLowerInvariant()
            });
        }

        /// <summary>An ad was shown (<c>ad_impression</c>). <paramref name="format"/>: rewarded, interstitial, banner, …</summary>
        public bool AdImpression(string network, string placement, string format)
        {
            return Record("ad_impression", null, Ad(network, placement, format));
        }

        /// <summary>Your ad SDK reported paid revenue for an impression (<c>ad_revenue</c>), in Toman.</summary>
        public bool AdRevenue(string network, string placement, string format, double revenue)
        {
            return Record("ad_revenue", revenue, Ad(network, placement, format));
        }

        /// <summary>Onboarding started (<c>tutorial_begin</c>).</summary>
        public bool TutorialBegin(string step = null)
        {
            return Record("tutorial_begin", null, new Dictionary<string, object> { ["step"] = step });
        }

        /// <summary>Onboarding finished (<c>tutorial_complete</c>).</summary>
        public bool TutorialComplete(string step = null)
        {
            return Record("tutorial_complete", null, new Dictionary<string, object> { ["step"] = step });
        }

        /// <summary>A level, match or round started (<c>level_start</c>).</summary>
        public bool LevelStart(string level)
        {
            return Record("level_start", null, new Dictionary<string, object> { ["level"] = level });
        }

        /// <summary>A level, match or round won (<c>level_complete</c>).</summary>
        public bool LevelComplete(string level, double? score = null, double? durationSeconds = null)
        {
            return Record("level_complete", score,
                new Dictionary<string, object> { ["level"] = level, ["duration_s"] = durationSeconds });
        }

        /// <summary>A level, match or round lost (<c>level_fail</c>).</summary>
        public bool LevelFail(string level, double? score = null, double? durationSeconds = null, string reason = null)
        {
            return Record("level_fail", score, new Dictionary<string, object>
            {
                ["level"] = level, ["duration_s"] = durationSeconds, ["reason"] = reason
            });
        }

        /// <summary>In-game currency or items gained (<c>resource_earn</c>).</summary>
        public bool ResourceEarn(string currency, double amount, string item = null, string source = null)
        {
            return Record("resource_earn", amount, new Dictionary<string, object>
            {
                ["currency"] = currency, ["item"] = item, ["source"] = source
            });
        }

        /// <summary>In-game currency or items spent (<c>resource_spend</c>).</summary>
        public bool ResourceSpend(string currency, double amount, string item = null, string sink = null)
        {
            return Record("resource_spend", amount, new Dictionary<string, object>
            {
                ["currency"] = currency, ["item"] = item, ["sink"] = sink
            });
        }

        /// <summary>
        /// Queue one event: the methods above, and the page events the SDK sends itself. Returns false
        /// when it was dropped (invalid, server-only or disabled).
        /// </summary>
        internal bool Record(string eventKey, double? value = null, IDictionary<string, object> props = null)
        {
            if (!Enabled) return false;
            if (eventKey == null || !EventName.IsMatch(eventKey))
            {
                Warn("[baziness] event \"" + eventKey + "\" dropped: name must be 1-128 of a-z 0-9 _ : . -");
                return false;
            }
            if (ServerOnlyEvents.Contains(eventKey))
            {
                Warn("[baziness] event \"" + eventKey + "\" dropped: only your game server may send it (server SDK)");
                return false;
            }
            var evt = new Dictionary<string, object>
            {
                ["eventId"] = Guid.NewGuid().ToString(),
                ["eventKey"] = eventKey,
                ["clientTime"] = clock().ToString("yyyy-MM-ddTHH:mm:ss.fffZ", System.Globalization.CultureInfo.InvariantCulture),
                ["sessionId"] = SessionId
            };
            if (value.HasValue && !double.IsNaN(value.Value) && !double.IsInfinity(value.Value)) evt["value"] = value.Value;
            var cleanProps = Props(props);
            if (cleanProps != null) evt["props"] = cleanProps;
            queue.Add(evt);
            if (queue.Count > maxQueueSize) queue.RemoveRange(0, queue.Count - maxQueueSize);
            Save();
            if (queue.Count >= MaxBatch) _ = Flush();
            return true;
        }

        /// <summary>Call regularly (the SDK's runner does, once a second): sends when the interval has passed.</summary>
        public void Tick()
        {
            if (clock() < nextFlush) return;
            nextFlush = clock() + flushInterval;
            _ = Flush();
        }

        /// <summary>Send what is queued. <paramref name="ignoreBackoff"/> on pause/quit. Never throws.</summary>
        public Task Flush(bool ignoreBackoff = false)
        {
            if (ignoreBackoff) retryAt = DateTime.MinValue;
            if (sending == null || sending.IsCompleted) sending = Drain();
            return sending;
        }

        private async Task Drain()
        {
            while (queue.Count > 0 && clock() >= retryAt)
            {
                var batch = queue.GetRange(0, Math.Min(MaxBatch, queue.Count));
                bool done;
                try
                {
                    done = await Send(batch);
                }
                catch (Exception)
                {
                    done = false;
                }
                if (!done)
                {
                    retryAt = clock() + Backoff[Math.Min(failures, Backoff.Length - 1)];
                    failures++;
                    return;
                }
                failures = 0;
                retryAt = DateTime.MinValue;
                var sent = new HashSet<object>(batch);
                queue.RemoveAll(sent.Contains);
                Save();
            }
        }

        /// <summary>True when the batch is done with (sent, or wrong and dropped); false to keep it.</summary>
        private async Task<bool> Send(List<object> batch)
        {
            var body = MiniJson.Serialize(new Dictionary<string, object>
            {
                ["events"] = batch, ["sessionId"] = SessionId, ["appVersion"] = AppVersion
            });
            for (var attempt = 0; attempt < 2; attempt++)
            {
                var accessToken = await token(attempt > 0);
                var result = await http.Send("POST", apiBase + "/analytics/events/batch", body,
                    new Dictionary<string, string> { ["Content-Type"] = "application/json", ["Authorization"] = "Bearer " + accessToken });
                if (result.Status == 401) continue;
                if (result.Ok)
                {
                    var answer = MiniJson.Object(SafeParse(result.Body));
                    if (MiniJson.Long(answer, "rejected") > 0)
                        Warn("[baziness] " + MiniJson.Long(answer, "rejected") + " event(s) rejected: " + MiniJson.Serialize(answer.TryGetValue("errors", out var e) ? e : null));
                    return true;
                }
                if (result.Status == 0 || result.Status == 429 || result.Status >= 500) return false;
                Warn("[baziness] batch of " + batch.Count + " dropped: HTTP " + result.Status);
                return true;
            }
            return false;
        }

        private List<object> Load()
        {
            try
            {
                return SafeParse(storage.Load()) as List<object> ?? new List<object>();
            }
            catch (Exception)
            {
                return new List<object>();
            }
        }

        private void Save()
        {
            storage.Save(queue.Count == 0 ? null : MiniJson.Serialize(queue));
        }

        private static object SafeParse(string json)
        {
            try
            {
                return MiniJson.Deserialize(json);
            }
            catch (FormatException)
            {
                return null;
            }
        }

        private static Dictionary<string, object> Ad(string network, string placement, string format)
        {
            return new Dictionary<string, object> { ["network"] = network, ["placement"] = placement, ["format"] = format };
        }

        private static string GatewayName(PurchaseGateway gateway)
        {
            return gateway == PurchaseGateway.BazinessPay ? "baziness_pay" : gateway.ToString().ToLowerInvariant();
        }

        private static Dictionary<string, object> Props(IDictionary<string, object> props)
        {
            if (props == null) return null;
            var result = new Dictionary<string, object>();
            foreach (var pair in props)
            {
                if (pair.Value == null) continue;
                var text = Convert.ToString(pair.Value, System.Globalization.CultureInfo.InvariantCulture);
                if (string.IsNullOrEmpty(text)) continue;
                if (result.Count >= 32) break;
                var key = pair.Key.Length > 64 ? pair.Key.Substring(0, 64) : pair.Key;
                result[key] = text.Length > 512 ? text.Substring(0, 512) : text;
            }
            return result.Count > 0 ? result : null;
        }
    }
}
