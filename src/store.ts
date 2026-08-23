/**
 * Platform-agnostic cache used by the routing engine.
 *
 * The same engine runs in two places: a Bun process during local development,
 * and the browser on GitHub Pages. Rather than fork the code, everything that
 * needs persistence goes through this interface, and each platform supplies its
 * own implementation at startup.
 */

export interface CacheEntry {
  at: number;
  body: unknown;
}

export interface Store {
  get(key: string): Promise<CacheEntry | null>;
  set(key: string, body: unknown): Promise<void>;
}

/** Fallback used before a real store is installed, and in tests. */
export class MemoryStore implements Store {
  private map = new Map<string, CacheEntry>();

  async get(key: string): Promise<CacheEntry | null> {
    return this.map.get(key) ?? null;
  }

  async set(key: string, body: unknown): Promise<void> {
    this.map.set(key, { at: Date.now(), body });
  }
}

/**
 * IndexedDB, for the browser build. Chosen over localStorage because a street
 * network for one neighbourhood comfortably exceeds the 5MB string quota, and
 * because it stores structured values without a JSON round trip.
 */
export class IndexedDbStore implements Store {
  private ready: Promise<IDBDatabase | null>;

  constructor(
    private dbName = "sanbu",
    private storeName = "cache",
  ) {
    this.ready = this.open();
  }

  private open(): Promise<IDBDatabase | null> {
    return new Promise((resolve) => {
      if (typeof indexedDB === "undefined") return resolve(null);
      const req = indexedDB.open(this.dbName, 1);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(this.storeName)) {
          db.createObjectStore(this.storeName);
        }
      };
      req.onsuccess = () => resolve(req.result);
      // Private browsing and some lockdown modes reject IndexedDB outright.
      // Losing the cache is survivable; failing to plan a walk is not.
      req.onerror = () => resolve(null);
    });
  }

  async get(key: string): Promise<CacheEntry | null> {
    const db = await this.ready;
    if (!db) return null;
    return new Promise((resolve) => {
      const tx = db.transaction(this.storeName, "readonly");
      const req = tx.objectStore(this.storeName).get(key);
      req.onsuccess = () => resolve((req.result as CacheEntry) ?? null);
      req.onerror = () => resolve(null);
    });
  }

  async set(key: string, body: unknown): Promise<void> {
    const db = await this.ready;
    if (!db) return;
    return new Promise((resolve) => {
      const tx = db.transaction(this.storeName, "readwrite");
      tx.objectStore(this.storeName).put({ at: Date.now(), body }, key);
      tx.oncomplete = () => resolve();
      // A full quota should degrade to "uncached", not throw.
      tx.onerror = () => resolve();
      tx.onabort = () => resolve();
    });
  }
}

let current: Store = new MemoryStore();

export function setStore(store: Store): void {
  current = store;
}

/** Read through the active store, producing and caching a value on a miss. */
export async function cached<T>(
  key: string,
  maxAgeMs: number,
  produce: () => Promise<T>,
): Promise<T> {
  const store = current;
  const hit = await store.get(key);
  if (hit && Date.now() - hit.at <= maxAgeMs) return hit.body as T;

  const fresh = await produce();
  await store.set(key, fresh);
  return fresh;
}
