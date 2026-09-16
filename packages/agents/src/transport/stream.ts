/**
 * Wrap an async generator in a one-shot async iterable.
 *
 * Subscription transports (e.g. tRPC) consume the iterable once and may bail
 * early (client disconnect, abort). This adapter forwards `next`/`return`
 * straight to the generator so cancellation propagates and the generator's
 * `finally` runs. Generic stream plumbing — kept transport-side so callers that
 * don't drive the harness can still use it.
 */
export function freshIterable<T>(gen: AsyncGenerator<T>): AsyncIterable<T> {
  return {
    [Symbol.asyncIterator]() {
      return {
        next: () => gen.next(),
        return: () => gen.return(undefined),
      };
    },
  };
}
