using System;
using System.Globalization;
using UnityEngine;

namespace Baziness
{
    /// <summary>Collects <see cref="DeviceInfo"/> from Unity's <c>SystemInfo</c>, <c>Screen</c> and <c>Application</c>.</summary>
    public static class UnityDevice
    {
        private const string DeviceIdKey = "baziness_device_id";

        public static DeviceInfo Collect(string store)
        {
            var deviceId = PlayerPrefs.GetString(DeviceIdKey, "");
            if (string.IsNullOrEmpty(deviceId))
            {
                deviceId = Guid.NewGuid().ToString();
                PlayerPrefs.SetString(DeviceIdKey, deviceId);
                PlayerPrefs.Save();
            }
            return new DeviceInfo
            {
                deviceId = deviceId,
                platform = Platform(),
                store = store,
                model = SystemInfo.deviceModel,
                deviceType = DeviceType(),
                os = OsName(),
                osVersion = SystemInfo.operatingSystem,
                appVersion = Application.version,
                locale = CultureInfo.CurrentCulture.Name,
                timezone = TimeZoneInfo.Local.Id,
                screenWidth = Screen.width,
                screenHeight = Screen.height,
                dpi = (int)Screen.dpi,
                memoryMb = SystemInfo.systemMemorySize,
                installer = Application.installerName,
                network = Application.internetReachability == NetworkReachability.ReachableViaLocalAreaNetwork ? "wifi"
                    : Application.internetReachability == NetworkReachability.ReachableViaCarrierDataNetwork ? "cellular" : "offline"
            };
        }

        /// <summary><c>platform</c> as the server SDK's <c>create-user</c> takes it.</summary>
        public static string Platform()
        {
            if (Application.isEditor) return "Editor";
            switch (Application.platform)
            {
                case RuntimePlatform.Android: return "Android";
                case RuntimePlatform.IPhonePlayer: return "Ios";
                case RuntimePlatform.WebGLPlayer: return "Web";
                case RuntimePlatform.WindowsPlayer: return "Windows";
                case RuntimePlatform.OSXPlayer: return "Mac";
                case RuntimePlatform.LinuxPlayer: return "Linux";
                default: return Application.platform.ToString();
            }
        }

        private static string OsName()
        {
            switch (SystemInfo.operatingSystemFamily)
            {
                case OperatingSystemFamily.Windows: return "Windows";
                case OperatingSystemFamily.MacOSX: return Application.platform == RuntimePlatform.IPhonePlayer ? "iOS" : "macOS";
                case OperatingSystemFamily.Linux: return "Linux";
                default:
                    return Application.platform == RuntimePlatform.Android ? "Android"
                        : Application.platform == RuntimePlatform.IPhonePlayer ? "iOS" : "Other";
            }
        }

        private static string DeviceType()
        {
            switch (SystemInfo.deviceType)
            {
                case UnityEngine.DeviceType.Handheld:
                    // A large short side means a tablet.
                    var inches = Math.Min(Screen.width, Screen.height) / Math.Max(Screen.dpi, 1f);
                    return inches >= 3.5f ? "tablet" : "phone";
                case UnityEngine.DeviceType.Desktop: return "desktop";
                case UnityEngine.DeviceType.Console: return "console";
                default: return "unknown";
            }
        }
    }
}
