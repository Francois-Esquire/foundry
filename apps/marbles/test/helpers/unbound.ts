export function unbound<T extends object>(name: string): T {
  return new Proxy({} as T, {
    get(_target, property) {
      if (property === "then") {
        return;
      }
      throw new Error(`${name} is not available in this host`);
    },
  });
}
