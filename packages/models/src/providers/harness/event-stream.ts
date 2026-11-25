export function eventStream<T>(): {
  stream: AsyncIterable<T>;
  push: (value: T) => void;
  close: () => void;
} {
  const items: T[] = [];
  const state: { closed: boolean } = { closed: false };
  let wake: (() => void) | undefined;
  return {
    close() {
      state.closed = true;
      wake?.();
    },
    push(value) {
      if (!state.closed) {
        items.push(value);
        wake?.();
      }
    },
    stream: {
      async *[Symbol.asyncIterator]() {
        while (!state.closed || items.length > 0) {
          if (items.length > 0) {
            yield items.shift() as T;
          } else {
            await new Promise<void>((resolve) => {
              wake = resolve;
            });
          }
        }
      },
    },
  };
}
