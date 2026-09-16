/**
 * Code-unit order, not locale order.
 *
 * SQLite's default `BINARY` collation is what the durable store sorts by, so
 * the scanner, the in-memory store, and the conformance suite all have to mean
 * the same thing by "sorted". Locale collation would order `a.md` against
 * `A.md` differently from the database and make one ordering two.
 */
/**
 * A total comparator over a string key.
 *
 * Total matters: a comparator that never returns 0 for equal keys leaves
 * `sort` free to separate equal elements, which breaks any caller that reads
 * duplicates off adjacency.
 */
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
