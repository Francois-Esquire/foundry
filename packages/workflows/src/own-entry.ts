export function defineOwnEntry<V>(
  target: Record<string, V>,
  key: string,
  value: V
): void {
  Object.defineProperty(target, key, {
    configurable: true,
    enumerable: true,
    value,
    writable: true,
  });
}
