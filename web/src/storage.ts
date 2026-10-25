/** `localStorage` when the browser allows it (private windows and sandboxed iframes may not), memory otherwise. */
export interface KeyValueStore {
  get(key: string): string | null;
  set(key: string, value: string): void;
  remove(key: string): void;
}

export function browserStore(): KeyValueStore {
  const memory = new Map<string, string>();
  const local = (): Storage | null => {
    try {
      return typeof localStorage === 'undefined' ? null : localStorage;
    } catch {
      return null;
    }
  };
  return {
    get(key) {
      try {
        return local()?.getItem(key) ?? memory.get(key) ?? null;
      } catch {
        return memory.get(key) ?? null;
      }
    },
    set(key, value) {
      memory.set(key, value);
      try {
        local()?.setItem(key, value);
      } catch {
        // Quota or blocked storage: the memory copy keeps this page working.
      }
    },
    remove(key) {
      memory.delete(key);
      try {
        local()?.removeItem(key);
      } catch {
        // ignored, as above
      }
    },
  };
}

export function memoryStore(): KeyValueStore {
  const memory = new Map<string, string>();
  return {
    get: (key) => memory.get(key) ?? null,
    set: (key, value) => void memory.set(key, value),
    remove: (key) => void memory.delete(key),
  };
}

export function readJson<T>(store: KeyValueStore, key: string): T | null {
  const text = store.get(key);
  if (!text) return null;
  try {
    return JSON.parse(text) as T;
  } catch {
    return null;
  }
}

export function uuid(): string {
  const cryptoApi = (globalThis as { crypto?: Crypto }).crypto;
  if (cryptoApi?.randomUUID) return cryptoApi.randomUUID();
  const bytes = new Uint8Array(16);
  if (cryptoApi?.getRandomValues) cryptoApi.getRandomValues(bytes);
  else for (let i = 0; i < 16; i++) bytes[i] = Math.floor(Math.random() * 256);
  bytes[6] = (bytes[6]! & 0x0f) | 0x40;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
