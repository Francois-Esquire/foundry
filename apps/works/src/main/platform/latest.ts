/** A changing value as {@link latest} follows it. */
export interface Followed<Value> {
  /** The value now; `undefined` ends the stream. */
  read(): Value | undefined | Promise<Value | undefined>;
  /** Whether `next` is nothing new after `previous`, so it is not yielded. */
  same?(previous: Value, next: Value): boolean;
  /** Ends the stream; without one it ends when the consumer stops. */
  readonly signal?: AbortSignal | undefined;
  /** Calls `changed` after each change until the returned function runs. */
  subscribe(changed: () => void): () => void;
}

/**
 * Follows a changing value: subscribes before the first read, so no change
 * falls in between, yields that value, then reads again after each change
 * and yields what is new. Changes that arrive while the consumer is busy
 * collapse into one read; nothing is buffered. Ends when `signal` aborts,
 * also during a read, or a read finds nothing.
 */
export async function* latest<Value>(
  followed: Followed<Value>
): AsyncGenerator<Value, void> {
  const signal = followed.signal ?? new AbortController().signal;
  let changed = false;
  let wake: (() => void) | undefined;
  const woken = () => wake?.();
  const unsubscribe = followed.subscribe(() => {
    changed = true;
    wake?.();
  });
  signal.addEventListener("abort", woken, { once: true });
  try {
    let last: Value | undefined;
    for (;;) {
      changed = false;
      const next = await readUnlessAborted(followed, signal);
      if (next === undefined || signal.aborted) {
        return;
      }
      if (last === undefined || !followed.same?.(last, next)) {
        last = next;
        yield next;
      }
      await new Promise<void>((resolve) => {
        wake = resolve;
        if (changed || signal.aborted) {
          resolve();
        }
      });
      wake = undefined;
      if (signal.aborted) {
        return;
      }
    }
  } finally {
    wake = undefined;
    unsubscribe();
    signal.removeEventListener("abort", woken);
  }
}

/** The read, or nothing once `signal` aborts first; a read left behind may still fail. */
async function readUnlessAborted<Value>(
  followed: Pick<Followed<Value>, "read">,
  signal: AbortSignal
): Promise<Value | undefined> {
  if (signal.aborted) {
    return;
  }
  const read = followed.read();
  if (!(read instanceof Promise)) {
    return read;
  }
  read.catch(() => undefined);
  let stop: () => void = () => undefined;
  const aborted = new Promise<undefined>((resolve) => {
    stop = () => resolve(undefined);
    signal.addEventListener("abort", stop, { once: true });
  });
  try {
    return await Promise.race([read, aborted]);
  } finally {
    signal.removeEventListener("abort", stop);
  }
}

/** A value whose changes {@link latest} can follow. */
export class Changing<Value> {
  readonly #listeners = new Set<() => void>();
  #value: Value;

  constructor(value: Value) {
    this.#value = value;
  }

  get value(): Value {
    return this.#value;
  }

  set(value: Value): void {
    this.#value = value;
    for (const listener of [...this.#listeners]) {
      listener();
    }
  }

  subscribe(changed: () => void): () => void {
    this.#listeners.add(changed);
    return () => {
      this.#listeners.delete(changed);
    };
  }
}
