import { type AsyncScope, asyncScope } from "@foundry/lib/async-scope";
import { withAbort } from "./abort";

export class ReentrantCallError extends Error {
  override readonly name = "ReentrantCallError";
}

export interface Turn {
  held: boolean;
}

export interface TurnRunOptions {
  readonly signal?: AbortSignal;
}

export class Turns {
  readonly #current: AsyncScope<Turn>;
  readonly #reentry: string;
  #tail: Promise<unknown> = Promise.resolve();

  constructor(reentry: string, scope: AsyncScope<Turn> = asyncScope<Turn>()) {
    this.#reentry = reentry;
    this.#current = scope;
  }

  get reentrancyGuarded(): boolean {
    return this.#current.active !== false;
  }

  run<T>(
    operation: () => T | PromiseLike<T>,
    options?: TurnRunOptions
  ): Promise<T> {
    if (this.#current.get()?.held === true) {
      return Promise.reject(new ReentrantCallError(this.#reentry));
    }
    const signal = options?.signal;
    if (signal?.aborted) {
      return Promise.reject(signal.reason);
    }
    const previous = this.#tail;
    const { promise: done, resolve: release } = Promise.withResolvers<void>();
    this.#tail = previous.then(() => done);
    const turn: Turn = { held: false };
    const ready = signal === undefined ? previous : withAbort(previous, signal);
    const result = ready.then(() => {
      if (signal?.aborted) {
        throw signal.reason;
      }
      turn.held = true;
      return this.#current.run(turn, operation);
    });
    return result.finally(() => {
      turn.held = false;
      release();
    });
  }
}
