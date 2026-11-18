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
