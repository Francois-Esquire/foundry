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
