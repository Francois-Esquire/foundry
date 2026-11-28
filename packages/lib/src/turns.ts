import { type AsyncScope, asyncScope } from "@foundry/lib/async-scope";

export class ReentrantCallError extends Error {
  override readonly name = "ReentrantCallError";
}

export interface Turn {
  held: boolean;
}

export class Turns {
  readonly #current: AsyncScope<Turn>;
  readonly #reentry: string;
  #tail: Promise<unknown> = Promise.resolve();

  constructor(reentry: string, scope: AsyncScope<Turn> = asyncScope<Turn>()) {
    this.#reentry = reentry;
    this.#current = scope;
  }

  run<T>(operation: () => Promise<T>): Promise<T> {
    if (this.#current.get()?.held === true) {
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
