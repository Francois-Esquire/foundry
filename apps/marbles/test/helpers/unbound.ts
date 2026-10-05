/** A stand-in that refuses every call: for a test that must not reach one. */
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
