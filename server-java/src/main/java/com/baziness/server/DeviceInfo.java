package com.baziness.server;

import java.util.LinkedHashMap;
import java.util.Map;

/**
 * What the device SDK reports about the player's device ({@code BazinessSdk.Device} in Unity,
 * {@code Baziness.device} on the web). The game server forwards it with the session start, so it
 * reaches Baziness through the trusted channel.
 */
public final class DeviceInfo {
    public String deviceId;
    public String platform;
    public String store;
    public String model;
    public String manufacturer;
    /** {@code phone}, {@code tablet}, {@code desktop}, {@code console} or {@code unknown}. */
    public String deviceType;
    public String os;
    public String osVersion;
    public String appVersion;
    /** {@code unity} or {@code web}. */
    public String sdk;
    public String sdkVersion;
    public String locale;
    public String timezone;
    public Integer screenWidth;
    public Integer screenHeight;
    public Integer dpi;
    public Integer memoryMb;
    public String browser;
    public String installer;
    public String network;

    /** Reads the JSON the device SDK sends ({@code null} or invalid JSON give an empty object). */
    public static DeviceInfo fromJson(String json) {
        if (json == null || json.trim().isEmpty()) {
            return new DeviceInfo();
        }
        try {
            return fromMap(Json.object(Json.parse(json)));
        } catch (IllegalArgumentException e) {
            return new DeviceInfo();
        }
    }

    /** Reads the map the device SDK sends (its JSON field names). */
    public static DeviceInfo fromMap(Map<String, ?> values) {
        DeviceInfo device = new DeviceInfo();
        if (values == null) {
            return device;
        }
        device.deviceId = text(values.get("deviceId"));
        device.platform = text(values.get("platform"));
        device.store = text(values.get("store"));
        device.model = text(values.get("model"));
        device.manufacturer = text(values.get("manufacturer"));
        device.deviceType = text(values.get("deviceType"));
        device.os = text(values.get("os"));
        device.osVersion = text(values.get("osVersion"));
        device.appVersion = text(values.get("appVersion"));
        device.sdk = text(values.get("sdk"));
        device.sdkVersion = text(values.get("sdkVersion"));
        device.locale = text(values.get("locale"));
        device.timezone = text(values.get("timezone"));
        device.screenWidth = integer(values.get("screenWidth"));
        device.screenHeight = integer(values.get("screenHeight"));
        device.dpi = integer(values.get("dpi"));
        device.memoryMb = integer(values.get("memoryMb"));
        device.browser = text(values.get("browser"));
        device.installer = text(values.get("installer"));
        device.network = text(values.get("network"));
        return device;
    }

    /** As {@code device_info} props (snake_case strings, unset fields left out). */
    Map<String, Object> toProps() {
        Map<String, Object> props = new LinkedHashMap<String, Object>();
        props.put("device_id", deviceId);
        props.put("platform", platform);
        props.put("store", store);
        props.put("model", model);
        props.put("manufacturer", manufacturer);
        props.put("device_type", deviceType);
        props.put("os", os);
        props.put("os_version", osVersion);
        props.put("app_version", appVersion);
        props.put("sdk", sdk);
        props.put("sdk_version", sdkVersion);
        props.put("locale", locale);
        props.put("timezone", timezone);
        props.put("screen", screenWidth != null && screenHeight != null ? screenWidth + "x" + screenHeight : null);
        props.put("dpi", dpi);
        props.put("memory_mb", memoryMb);
        props.put("browser", browser);
        props.put("installer", installer);
        props.put("network", network);
        return props;
    }

    private static String text(Object value) {
        return value == null ? null : value.toString();
    }

    private static Integer integer(Object value) {
        if (value instanceof Number) {
            return ((Number) value).intValue();
        }
        if (value != null) {
            try {
                return Integer.parseInt(value.toString().trim());
            } catch (NumberFormatException ignored) {
                return null;
            }
        }
        return null;
    }
}
