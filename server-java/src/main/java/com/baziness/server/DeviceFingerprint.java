package com.baziness.server;

import java.util.LinkedHashMap;
import java.util.Map;

/**
 * The player's device as your server saw it, for fingerprint attribution: the IP and User-Agent of
 * the player's request (behind a proxy: the forwarded client IP), plus the model and OS version the
 * device SDK reports ({@code DeviceInfo.model}, {@code DeviceInfo.osVersion}). Without an IP, nothing
 * is matched. Unset fields are left out.
 */
public final class DeviceFingerprint {
    public String ip;
    public String userAgent;
    public String deviceModel;
    public String osVersion;

    public DeviceFingerprint() {
    }

    public DeviceFingerprint(String ip, String userAgent) {
        this.ip = ip;
        this.userAgent = userAgent;
    }

    /** Adds the model and OS version the device SDK reported. */
    public DeviceFingerprint withDevice(String deviceModel, String osVersion) {
        this.deviceModel = deviceModel;
        this.osVersion = osVersion;
        return this;
    }

    Map<String, Object> toWire() {
        Map<String, Object> wire = new LinkedHashMap<String, Object>();
        put(wire, "ip", ip == null ? null : ip.trim());
        put(wire, "userAgent", userAgent);
        put(wire, "deviceModel", deviceModel == null ? null : deviceModel.trim());
        put(wire, "osVersion", osVersion == null ? null : osVersion.trim());
        return wire;
    }

    private static void put(Map<String, Object> wire, String key, String value) {
        if (value != null && !value.isEmpty()) {
            wire.put(key, value);
        }
    }
}
