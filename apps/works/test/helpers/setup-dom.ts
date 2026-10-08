// Node 25+ defines a `localStorage` global that is undefined unless the
// process was started with `--localstorage-file`, and the happy-dom
// environment leaves an existing global key alone. Give the renderer suite a
// plain in-memory Storage when nothing usable is there.
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
