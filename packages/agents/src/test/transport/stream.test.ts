import { describe, expect, it } from "vitest";

import { freshIterable } from "../../transport";

// `freshIterable` exists so subscription transports can attach their own
// `Symbol.asyncDispose` for cleanup: a native async generator already carries
// one, and some transports (e.g. trpc-electron) throw trying to attach a second.
// The runtime-independent contract we can lock here: the wrapper exposes
// `Symbol.asyncIterator` but the iterator it returns does NOT define
// `Symbol.asyncDispose`, and it forwards the underlying generator's values.

// A native async generator is exactly what this test needs (no work to await).
// eslint-disable-next-line @typescript-eslint/require-await
async function* nativeGen(): AsyncGenerator<number> {
  yield 1;
  yield 2;
}

describe("freshIterable", () => {
  it("returns an iterator with no Symbol.asyncDispose for a transport to attach", () => {
    const wrapped = freshIterable(nativeGen());
    expect(Symbol.asyncIterator in wrapped).toBe(true);

    const iterator = wrapped[Symbol.asyncIterator]();
    expect(Symbol.asyncDispose in iterator).toBe(false);
  });

  it("forwards the underlying generator's values in order", async () => {
    const out: number[] = [];
    for await (const v of freshIterable(nativeGen())) {
      out.push(v);
    }
    expect(out).toEqual([1, 2]);
  });

  it("forwards early return() so the generator's finally runs", async () => {
    let cleanedUp = false;
    // A native async generator with nothing to await — it exists only to prove
    // `return()` propagates and runs the `finally`.
    // eslint-disable-next-line @typescript-eslint/require-await
    async function* withCleanup(): AsyncGenerator<number> {
      try {
        yield 1;
        yield 2;
      } finally {
        cleanedUp = true;
      }
    }
    const it = freshIterable(withCleanup())[Symbol.asyncIterator]();
    await it.next();
    await it.return?.(undefined);
    expect(cleanedUp).toBe(true);
  });
});
