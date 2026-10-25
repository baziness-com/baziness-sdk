using System;
using System.Collections.Generic;
using System.Text.RegularExpressions;
using System.Threading.Tasks;

namespace Baziness
{
    /// <summary>
    /// Player analytics from the device: gameplay, UI and funnel events (<c>level_complete</c>,
    /// <c>iap_purchase_started</c>, <c>shop:offer:clicked</c>, …), sent with the player's 15-minute
    /// token to <c>analytics/events/batch</c>. Queued in storage so a crash or going offline loses
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

        /// <summary>Queue one event. Returns false when it was dropped (invalid, server-only or disabled).</summary>
        public bool Track(string eventKey, double? value = null, IDictionary<string, object> props = null)
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
