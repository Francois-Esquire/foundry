function createMemoryStorage(): Storage {
  const entries = new Map<string, string>();
  return {
    clear() {
      entries.clear();
    },
    getItem(key) {
      return entries.get(key) ?? null;
    },
    key(index) {
      return [...entries.keys()][index] ?? null;
    },
    get length() {
      return entries.size;
    },
    removeItem(key) {
      entries.delete(key);
    },
    setItem(key, value) {
      entries.set(key, String(value));
    },
  };
}

if (globalThis.localStorage === undefined) {
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: createMemoryStorage(),
  });
}
