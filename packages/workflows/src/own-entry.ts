/**
 * Write `value` under `key` as an own, enumerable, writable, configurable
 * data property. An indexed assignment would instead run the inherited
 * `__proto__` setter for that key, dropping the entry or replacing the
 * target's prototype.
 */
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
