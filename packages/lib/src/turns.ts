import { AsyncLocalStorage } from "node:async_hooks";

/**
 * A call made from inside the turn it would have to wait for. It could only
 * ever wait for itself, so it is refused at once instead of hanging.
 */
export class ReentrantCallError extends Error {
  override readonly name = "ReentrantCallError";
}

interface Turn {
  /** True from when the turn's operation starts until it settles. */
  held: boolean;
}

/**
 * Runs one operation at a time, in call order, for one owner (a store, say).
 * A failed operation does not block the ones queued behind it.
 *
 * A call made from inside the running operation, directly or from anything
 * it started (an awaited callback, a hook), would queue behind that very
 * operation and never run. `run` refuses it with a `ReentrantCallError`
 * carrying `reentry`, the owner's advice on what to call instead. An
 * independent caller, including one concurrent with the operation, or a
 * callback the operation scheduled that runs after it settled, queues as
 * usual.
 *
 * Re-entry is told from concurrency by the asynchronous context the call is
 * made in (`AsyncLocalStorage`, available on Node, Bun, and Deno).
 */
export class Turns {
  readonly #current = new AsyncLocalStorage<Turn>();
  readonly #reentry: string;
  #tail: Promise<unknown> = Promise.resolve();

  constructor(reentry: string) {
    this.#reentry = reentry;
  }

  run<T>(operation: () => Promise<T>): Promise<T> {
    if (this.#current.getStore()?.held === true) {
      return Promise.reject(new ReentrantCallError(this.#reentry));
    }
    const turn: Turn = { held: false };
    const result = this.#tail.then(() => {
      turn.held = true;
      return this.#current.run(turn, operation);
    });
    const settled = result.finally(() => {
      turn.held = false;
    });
    this.#tail = settled.catch(() => undefined);
    return settled;
  }
}
