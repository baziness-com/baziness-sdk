using System;
using System.Collections.Generic;

namespace Baziness
{
    /// <summary>
    /// What the SDK knows about the player's device. Send it to your game server with the session
    /// request; the server reports it to Baziness (<c>device_info</c>) through the trusted channel.
    /// </summary>
    [Serializable]
    public sealed class DeviceInfo
    {
        public string deviceId;
        public string platform;
        public string store;
        public string model;
        public string manufacturer;
        /// <summary><c>phone</c>, <c>tablet</c>, <c>desktop</c>, <c>console</c> or <c>unknown</c>.</summary>
        public string deviceType;
        public string os;
        public string osVersion;
        public string appVersion;
        public string sdk = "unity";
        public string sdkVersion = BazinessSdkInfo.Version;
        public string locale;
        public string timezone;
        public int screenWidth;
        public int screenHeight;
        public int dpi;
        public int memoryMb;
        public string installer;
        public string network;

        /// <summary>The JSON fields the server SDK reads (<c>DeviceInfo.fromMap</c> / the Node type).</summary>
        public Dictionary<string, object> ToDictionary()
        {
            var values = new Dictionary<string, object>
            {
                ["deviceId"] = deviceId, ["platform"] = platform, ["store"] = store, ["model"] = model,
                ["manufacturer"] = manufacturer, ["deviceType"] = deviceType, ["os"] = os, ["osVersion"] = osVersion,
                ["appVersion"] = appVersion, ["sdk"] = sdk, ["sdkVersion"] = sdkVersion, ["locale"] = locale,
                ["timezone"] = timezone, ["installer"] = installer, ["network"] = network
            };
            if (screenWidth > 0) values["screenWidth"] = screenWidth;
            if (screenHeight > 0) values["screenHeight"] = screenHeight;
            if (dpi > 0) values["dpi"] = dpi;
            if (memoryMb > 0) values["memoryMb"] = memoryMb;
            return values;
        }
    }

    public static class BazinessSdkInfo
    {
        public const string Version = "1.2.0";
    }
}
