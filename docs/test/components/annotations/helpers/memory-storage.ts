/**
 * Node can shadow happy-dom's `window.localStorage` with an unconfigured
 * built-in, so lifecycle tests install a Map-backed store explicitly.
 */
export function installMemoryStorage() {
  const data = new Map<string, string>();
  let failing: ((key: string) => boolean) | undefined;
  Object.defineProperty(window, "localStorage", {
    configurable: true,
    value: {
      clear: () => data.clear(),
      getItem: (key: string) => data.get(key) ?? null,
      removeItem: (key: string) => data.delete(key),
      setItem: (key: string, value: string) => {
        if (failing?.(key)) {
          throw new Error("Quota exceeded");
        }
        data.set(key, value);
      },
    },
  });
  return {
    data,
    failWrites: (predicate?: (key: string) => boolean) => {
      failing = predicate;
    },
  };
}
