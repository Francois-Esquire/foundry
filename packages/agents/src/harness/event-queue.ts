export interface EventQueue<T> {
  close(): void;
  iterator(): AsyncIterator<T>;
  push(item: T): void;
}

/** Unbounded push queue with one async consumer; `close` ends iteration. */
export function createEventQueue<T>(): EventQueue<T> {
  const items: T[] = [];
  const waiters: ((result: IteratorResult<T>) => void)[] = [];
  let closed = false;

  return {
    close() {
      closed = true;
      let waiter = waiters.shift();
      while (waiter) {
        waiter({ done: true, value: undefined });
        waiter = waiters.shift();
      }
    },
    iterator() {
      return {
        next(): Promise<IteratorResult<T>> {
          if (items.length > 0) {
            return Promise.resolve({ done: false, value: items.shift() as T });
          }
          if (closed) {
            return Promise.resolve({ done: true, value: undefined });
          }
          return new Promise((resolve) => waiters.push(resolve));
        },
      };
    },
    push(item) {
      const waiter = waiters.shift();
      if (waiter) {
        waiter({ done: false, value: item });
      } else {
        items.push(item);
      }
    },
  };
}
