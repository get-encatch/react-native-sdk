const store = new Map<string, string>();

const AsyncStorage = {
  async getItem(key: string): Promise<string | null> {
    return store.has(key) ? (store.get(key) as string) : null;
  },
  async setItem(key: string, value: string): Promise<void> {
    store.set(key, value);
  },
  async removeItem(key: string): Promise<void> {
    store.delete(key);
  },
  async getAllKeys(): Promise<string[]> {
    return [...store.keys()];
  },
  async multiRemove(keys: string[]): Promise<void> {
    for (const k of keys) store.delete(k);
  },
  async clear(): Promise<void> {
    store.clear();
  },
};

/** Test helper: wipe everything between tests. */
export function __resetStorage(): void {
  store.clear();
}

/** Test helper: copy of everything stored (to simulate an app restart). */
export function __dumpStorage(): Record<string, string> {
  return Object.fromEntries(store);
}

/** Test helper: replace the store with a previous dump. */
export function __loadStorage(data: Record<string, string>): void {
  store.clear();
  for (const [k, v] of Object.entries(data)) store.set(k, v);
}

export default AsyncStorage;
