import { Effect } from "effect";

import type { Channels } from "./channels";
import type { Executable, ExecutableConfig, Witness } from "./executable";
import { errorToShape, runEffectPromise } from "./helpers";
import type { Step } from "./step";
import type { Bail } from "./types";
import { isBail, StepBailError } from "./types";

/**
 * Minimum shared state a Composer tree requires. `channels` is shared
 * by every node in the tree; a push at any leaf is visible at the root.
 */
export interface BaseScope {
  readonly channels: Channels;
}

// ── Parallel / Race types ─────────────────────────────────────────────────────

export interface ParallelEntry<I = unknown, O = unknown> {
  readonly input: I;
  readonly step: Step<I, O>;
}

export type ParallelOut<Specs extends Record<string, ParallelEntry>> = {
  [K in keyof Specs]: Specs[K] extends ParallelEntry<unknown, infer O>
    ? O
    : never;
};

export type RaceOut<Specs extends Record<string, ParallelEntry>> = {
  [K in keyof Specs]: Specs[K] extends ParallelEntry<unknown, infer O>
    ? { winner: K; value: O }
    : never;
}[keyof Specs];

/**
 * Tree node for building and traversing a shared-scope step tree.
 * Each node owns a forked Executable (per-frame input/name/path/context)
 * and a reference to the shared scope (channels).
 *
 * Lifecycle methods (mount, complete, fail) publish step events for
 * synthetic wrapper frames. Composition methods (#invoke, #parallel, #race,
 * #branch, #sequence) drive child steps via Effect and publish via channels.
 */
export class Composer<S extends BaseScope = BaseScope> {
  readonly name: string;
  readonly path: readonly string[];
  readonly scope: S;
  readonly executable: Executable;

  protected constructor(args: {
    name: string;
    scope: S;
    path: readonly string[];
    executable: Executable;
  }) {
    this.name = args.name;
    this.scope = args.scope;
    this.path = args.path;
    this.executable = args.executable;
  }

  /** Allocate the root node of a Composer tree. */
  static root<S extends BaseScope>(
    scope: S,
    executable: Executable
  ): Composer<S> {
    return new Composer({
      executable,
      name: executable.name,
      path: executable.path,
      scope,
    });
  }

  /** Allocate a child node; forks path and Executable. */
  fork(
    name: string,
    input?: unknown,
    config?: Partial<ExecutableConfig>
  ): Composer<S> {
    const childExec =
      arguments.length > 1
        ? this.executable.fork({ config, input, name })
        : this.executable.fork({ config, name });
    return new Composer({
      executable: childExec,
      name,
      path: [...this.path, name],
      scope: this.scope,
    });
  }

  /** Publish step.started event; returns this for chaining. */
  mount(attempt = 1): this {
    this.scope.channels.started(this.path, this.name, attempt);
    return this;
  }

  complete(value: unknown, attempt = 1): void {
    this.scope.channels.complete(this.path, this.name, attempt, value);
  }

  fail(error: Error, attempt = 1): void {
    this.scope.channels.failed(
      this.path,
      this.name,
      attempt,
      errorToShape(error)
    );
  }

  /** Drive a child step inline as a sub-frame of the current path. */
  #invoke<CI, CO>(
    step: Step<CI, CO>,
    input: CI,
    as?: string
  ): Effect.Effect<CO | Bail<unknown>, Error> {
    const child = this.fork(as ?? step.name, input);
    return child.executable.drive(child.#witness(), step as Step<unknown, CO>);
  }

  /** Run children concurrently under a synthetic wrapper frame. */
  #parallel<Specs extends Record<string, ParallelEntry>>(
    specs: Specs,
    name = "parallel"
  ): Effect.Effect<ParallelOut<Specs>, Error> {
    return this.#wrap(name, (wrapper) =>
      Effect.gen(function* () {
        const entries = Object.entries(specs);
        const tasks = entries.map(([k, spec]) => {
          const child = wrapper.fork(k, spec.input);
          return child.executable
            .drive(child.#witness(), spec.step)
            .pipe(Effect.map((v) => [k, v] as const));
        });
        const out = yield* Effect.all(tasks, { concurrency: "unbounded" });
        return Object.fromEntries(out) as ParallelOut<Specs>;
      })
    );
  }

  /** First child to resolve wins; losers are interrupted. */
  #race<Specs extends Record<string, ParallelEntry>>(
    specs: Specs,
    name = "race"
  ): Effect.Effect<RaceOut<Specs>, Error> {
    return this.#wrap(name, (wrapper) =>
      Effect.gen(function* () {
        const entries = Object.entries(specs) as [
          keyof Specs & string,
          ParallelEntry,
        ][];
        const arms = entries.map(([k, spec]) => {
          const child = wrapper.fork(k, spec.input);
          return child.executable.drive(child.#witness(), spec.step).pipe(
            // `value` is untyped (drive's O is unknown for these specs), so
            // narrowing to a RaceOut arm needs a cast — same as ParallelOut.
            // It is sound on `winner`: `k` is a genuine `keyof Specs`.
            Effect.map((value) => ({ value, winner: k }) as RaceOut<Specs>)
          );
        });
        const [first, ...rest] = arms;
        if (!first) {
          return yield* Effect.fail(new Error(`race "${name}" empty`));
        }
        return yield* rest.reduce((acc, next) => Effect.race(acc, next), first);
      })
    );
  }

  /** Predicate decides which arm runs; the other is never invoked. */
  #branch<CO>(
    predicate: (input: unknown) => boolean | Promise<boolean>,
    ifTrue: Step<unknown, CO>,
    ifFalse: Step<unknown, CO>,
    input: unknown,
    name = "branch"
  ): Effect.Effect<CO | Bail<unknown>, Error> {
    return this.#wrap(name, (wrapper) =>
      Effect.gen(function* () {
        const cond = yield* Effect.promise(() =>
          Promise.resolve(predicate(input))
        );
        const armKey = cond ? "ifTrue" : "ifFalse";
        const arm = cond ? ifTrue : ifFalse;
        const child = wrapper.fork(armKey, input);
        return yield* child.executable.drive(child.#witness(), arm);
      })
    );
  }

  /** Pipeline: each step's output feeds the next step's input. */
  #sequence<O>(
    steps: readonly Step[],
    initialInput: unknown,
    name = "sequence"
  ): Effect.Effect<O, Error> {
    return this.#wrap(name, (wrapper) =>
      Effect.gen(function* () {
        let value: unknown = initialInput;
        for (const step of steps) {
          const child = wrapper.fork(step.name, value);
          const result = yield* child.executable.drive(child.#witness(), step);
          if (isBail(result)) {
            return yield* Effect.fail(
              new Error(
                `Sequence "${name}" bailed at "${step.name}": ${JSON.stringify(
                  result.error
                )}`
              )
            );
          }
          value = result;
        }
        return value as O;
      })
    );
  }

  /**
   * Drive a child step inline as a sub-frame of the current path.
   * Promise twin of {@link #invoke}; throws {@link StepBailError} on Bail.
   */
  invoke<CI, CO>(step: Step<CI, CO>, input: CI, as?: string): Promise<CO> {
    return runEffectPromise(
      this.#invoke<CI, CO>(step, input, as).pipe(
        Effect.flatMap((result) =>
          isBail(result)
            ? Effect.fail(new StepBailError(step.name, result))
            : Effect.succeed(result)
        )
      )
    );
  }

  /**
   * Run children concurrently under a synthetic wrapper frame.
   * Throws on first child failure; siblings interrupted via abort substrate.
   */
  parallel<Specs extends Record<string, ParallelEntry>>(
    specs: Specs,
    name = "parallel"
  ): Promise<ParallelOut<Specs>> {
    return runEffectPromise(this.#parallel<Specs>(specs, name));
  }

  /**
   * First child to resolve wins; losers interrupted.
   * Returns { winner, value } identifying the winning entry.
   */
  race<Specs extends Record<string, ParallelEntry>>(
    specs: Specs,
    name = "race"
  ): Promise<RaceOut<Specs>> {
    return runEffectPromise(this.#race<Specs>(specs, name));
  }

  /**
   * Predicate decides which arm runs; the other is never invoked.
   * Throws {@link StepBailError} if the chosen arm bails.
   */
  branch<CO>(
    predicate: (input: unknown) => boolean | Promise<boolean>,
    ifTrue: Step<unknown, CO>,
    ifFalse: Step<unknown, CO>,
    input: unknown,
    name = "branch"
  ): Promise<CO> {
    return runEffectPromise(
      this.#branch<CO>(predicate, ifTrue, ifFalse, input, name).pipe(
        Effect.flatMap((result) =>
          isBail(result)
            ? Effect.fail(new StepBailError(name, result))
            : Effect.succeed(result)
        )
      )
    );
  }

  /**
   * Pipeline: each step's output feeds the next step's input.
   * A bail short-circuits and rejects the Promise.
   */
  sequence<O>(
    steps: readonly Step[],
    initialInput: unknown,
    name = "sequence"
  ): Promise<O> {
    return runEffectPromise(this.#sequence<O>(steps, initialInput, name));
  }

  #witness(): Witness {
    return { channels: this.scope.channels, composer: this };
  }

  /**
   * Synthetic-group lifecycle seam: forks wrapper, mounts, runs body,
   * publishes terminal event. Every grouping composition routes here.
   */
  #wrap<A>(
    name: string,
    body: (wrapper: Composer<S>) => Effect.Effect<A, Error>
  ): Effect.Effect<A, Error> {
    const wrapper = this.fork(name);
    return Effect.gen(function* () {
      wrapper.mount();
      return yield* body(wrapper).pipe(
        Effect.tap((value) =>
          Effect.sync(() => {
            wrapper.complete(value);
          })
        ),
        Effect.tapError((err) =>
          Effect.sync(() => {
            wrapper.fail(err instanceof Error ? err : new Error(String(err)));
          })
        )
      );
    });
  }
}
