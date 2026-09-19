/** Compare string keys by UTF-16 code units, independent of locale. */
export function byCodeUnit<T>(
  key: (value: T) => string
): (a: T, b: T) => number {
  return (a, b) => {
    const left = key(a);
    const right = key(b);
    if (left < right) {
      return -1;
    }
    return left > right ? 1 : 0;
  };
}
