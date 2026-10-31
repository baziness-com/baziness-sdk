import { uuid, type KeyValueStore } from './storage.js';

export const SDK_VERSION = '1.3.0';

/** What the SDK knows about the player's device. Send it to your server with the session request. */
export interface DeviceInfo {
  /** A random id kept in this browser; use your own player id on the server if you have one. */
  deviceId: string;
  platform: 'Web';
  store: 'Direct';
  deviceType: 'phone' | 'tablet' | 'desktop' | 'unknown';
  os?: string;
  osVersion?: string;
  browser?: string;
  model?: string;
  locale?: string;
  timezone?: string;
  screenWidth?: number;
  screenHeight?: number;
  dpi?: number;
  memoryMb?: number;
  network?: string;
  appVersion?: string;
  sdk: 'web';
  sdkVersion: string;
}

interface NavigatorExtras {
  deviceMemory?: number;
  connection?: { effectiveType?: string };
  userAgentData?: { mobile?: boolean; platform?: string };
}

const DEVICE_ID_KEY = 'baziness:device-id';

export function collectDevice(store: KeyValueStore, appVersion?: string): DeviceInfo {
  let deviceId = store.get(DEVICE_ID_KEY);
  if (!deviceId) {
    deviceId = uuid();
    store.set(DEVICE_ID_KEY, deviceId);
  }
  const nav = (typeof navigator === 'undefined' ? {} : navigator) as Navigator & NavigatorExtras;
  const ua = nav.userAgent ?? '';
  const { os, osVersion } = parseOs(ua, nav.userAgentData?.platform);
  const info: DeviceInfo = {
    deviceId,
    platform: 'Web',
    store: 'Direct',
    deviceType: deviceType(ua, nav.userAgentData?.mobile),
    sdk: 'web',
    sdkVersion: SDK_VERSION,
  };
  if (os) info.os = os;
  if (osVersion) info.osVersion = osVersion;
  const browser = parseBrowser(ua);
  if (browser) info.browser = browser;
  const model = ua.match(/Android [\d.]+; ([^;)]+?)(?: Build|\))/)?.[1]?.trim();
  if (model && model !== 'K') info.model = model;
  if (nav.language) info.locale = nav.language;
  try {
    info.timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  } catch {
    // older browsers
  }
  if (typeof screen !== 'undefined') {
    info.screenWidth = screen.width;
    info.screenHeight = screen.height;
  }
  if (typeof devicePixelRatio === 'number') info.dpi = Math.round(devicePixelRatio * 96);
  if (nav.deviceMemory) info.memoryMb = Math.round(nav.deviceMemory * 1024);
  if (nav.connection?.effectiveType) info.network = nav.connection.effectiveType;
  if (appVersion) info.appVersion = appVersion;
  return info;
}

export function parseOs(ua: string, hint?: string): { os?: string; osVersion?: string } {
  let match = ua.match(/Android ([\d.]+)/);
  if (match) return { os: 'Android', osVersion: match[1] };
  match = ua.match(/(?:iPhone|iPad|iPod).*? OS ([\d_]+)/);
  if (match) return { os: 'iOS', osVersion: match[1]!.replace(/_/g, '.') };
  match = ua.match(/Windows NT ([\d.]+)/);
  if (match) return { os: 'Windows', osVersion: match[1] };
  match = ua.match(/Mac OS X ([\d_.]+)/);
  if (match) return { os: 'macOS', osVersion: match[1]!.replace(/_/g, '.') };
  if (/CrOS/.test(ua)) return { os: 'ChromeOS' };
  if (/Linux/.test(ua)) return { os: 'Linux' };
  return hint ? { os: hint } : {};
}

export function parseBrowser(ua: string): string | undefined {
  const rules: Array<[RegExp, string]> = [
    [/EdgA?\/([\d.]+)/, 'Edge'],
    [/SamsungBrowser\/([\d.]+)/, 'Samsung Internet'],
    [/OPR\/([\d.]+)/, 'Opera'],
    [/Firefox\/([\d.]+)/, 'Firefox'],
    [/CriOS\/([\d.]+)/, 'Chrome'],
    [/Chrome\/([\d.]+)/, 'Chrome'],
    [/Version\/([\d.]+).*Safari/, 'Safari'],
  ];
  for (const [pattern, name] of rules) {
    const match = ua.match(pattern);
    if (match) return `${name} ${match[1]!.split('.')[0]}`;
  }
  return undefined;
}

function deviceType(ua: string, mobileHint?: boolean): DeviceInfo['deviceType'] {
  if (/iPad|Tablet/.test(ua) || (/Android/.test(ua) && !/Mobile/.test(ua))) return 'tablet';
  if (mobileHint || /Mobi|iPhone|iPod|Android/.test(ua)) return 'phone';
  if (ua) return 'desktop';
  return 'unknown';
}
