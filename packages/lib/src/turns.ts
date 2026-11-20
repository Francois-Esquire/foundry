import { AsyncLocalStorage } from "node:async_hooks";

export class ReentrantCallError extends Error {
  override readonly name = "ReentrantCallError";
}

interface Turn {
  held: boolean;
}

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
