export interface Followed<Value> {
  read(): Value | undefined | Promise<Value | undefined>;
  same?(previous: Value, next: Value): boolean;
  readonly signal?: AbortSignal | undefined;
  subscribe(changed: () => void): () => void;
}

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
