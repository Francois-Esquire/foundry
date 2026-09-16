import type { Schedule, Scope } from "effect";

import { Effect, HashMap, Option, Ref, Schema } from "effect";

import type { Channels, SuspensionRequest, SuspensionState } from "./channels";
import type { Composer, ParallelEntry } from "./composer";
import { resolveStepExecution } from "./config";
import { JsonValueSchema } from "./execution-records";
import {
  errorToShape,
  parseDuration,
  resolveInput,
  runEffectPromise,
  toSchedule,
} from "./helpers";
import type { Step, StepContext } from "./step";
import type { Bail, Duration, RetryPolicy, Unsubscribe } from "./types";
import { isBail, StepBailError } from "./types";

/**
 * Per-frame execution unit. Owns input, name, path, context, cancellation
 * control, and suspension resolutions. Config (`blocking`, `maxAttempts`,
 * `timeout`, `retry`) are per-Run defaults; Step metadata overrides.
 *
 * Attempt count lives in {@link drive}'s local Ref and stamps each event
 * for correlation. Identity-free (no `runId`/`queueId`). Scope-managed
 * for clean cancellation teardown.
 */

// ── BaseContext + ExecutableConfig ──

/**
 * Base context shape every frame carries. `name` is the current
 * frame's path segment (matches `path[path.length - 1]`).
 */
export interface BaseContext {
  readonly name: string;
}

/**
 * Per-Run defaults. Each field is overridable at the Step level via
 * Step metadata; this is the fallback.
 */
export interface ExecutableConfig {
  /** Caller waits for child completion. False = fire-and-forget. */
  readonly blocking: boolean;
  /** Ceiling on retry attempts (1 = no retry, just one try). */
  readonly maxAttempts: number;
  /** Full retry policy. Undefined = no retry. */
  readonly retry?: RetryPolicy;
  /** Per-step timeout. Undefined = no timeout. */
  readonly timeout?: Duration;
}

const defaultConfig: ExecutableConfig = {
  blocking: true,
  maxAttempts: 1,
};

// ── SuspendSignal — sentinel error ──

export class SuspendSignal extends Error {
  readonly suspension: SuspensionState;
  readonly originPath: readonly string[];
  constructor(suspension: SuspensionState, originPath: readonly string[]) {
    super(`Suspended: ${suspension.name}`);
    this.name = "SuspendSignal";
    this.suspension = suspension;
    this.originPath = originPath;
  }
}

export const isSuspendSignal = (e: unknown): e is SuspendSignal =>
  e instanceof SuspendSignal;

export function suspensionOccurrenceKey(
  stepPath: readonly string[],
  name: string,
  occurrence: number
): string {
  return JSON.stringify([stepPath, name, occurrence]);
}

// ── Witness ──

/**
 * Runtime surface Executable needs: Channels for step events, plus
 * per-frame Composer for nested composition. Channels' `events.push`
 * synchronously projects into Snapshot.
 */
export interface Witness {
  readonly channels: Channels;
  /**
   * Composer owning the current frame. Routes `ctx.parallel/race/...`
   * to the current frame (not the step's original composer).
   */
  readonly composer?: Composer;
}

// ── drive helpers ──

/**
 * Options layered onto {@link Executable.drive} by {@link Step.run}.
 * Composer-driven synthetic frames pass none (lean composition path).
 */
export interface DriveOptions<I> {
  /**
   * Validation hook invoked on the completed (non-bail) result value
   * immediately before the terminal `step.complete` event. {@link Step.run}
   * supplies a JSON-serializability guard here; Composer frames pass none.
   */
  readonly assertResult?: (value: unknown) => void;
  /** Extra fields layered onto the body `ctx` (from `step.invoke(input, ext)`). */
  readonly ctxExtension?: object;
  /** Override the frame's bound input for this drive. */
  readonly input?: I;
  /**
   * Enable Step-only lifecycle hooks: pre-exec short-circuits
   * (skip / abort / persisted-complete), the pause gate, post-body child
   * cascade with `progress=100`, abort-failed suppression, and the
   * `ctx.next` / `ctx.pipe` middleware affordances. Off for Composer
   * frames so leaf composition doesn't pay for them.
   */
  readonly stepMode?: boolean;
}

/**
 * Path-relative lookup keys for `ctx.resultOf` / `ctx.statusOf`. Sibling
 * scope (same parent namespace) first, then child scope. Callers iterate
 * in order and take the first present record.
 */
function lookupKeys(
  path: readonly string[],
  name: string
): readonly [string, string] {
  const siblingNs = path.slice(0, -1).join(".");
  const siblingKey = siblingNs.length > 0 ? `${siblingNs}.${name}` : name;
  const childKey = path.length > 0 ? `${path.join(".")}.${name}` : name;
  return [siblingKey, childKey];
}

/**
 * Normalize a step body to a Promise. Async-function bodies resolve
 * directly; async-generator bodies are driven to completion with each
 * `yield` routed through `ctx.write` (string → text, `undefined`/`null`
 * → no-op, else → data chunk), and the generator's `return` value
 * becomes the step output.
 *
 * Cancellation: if `signal` aborts between yields, the iterator is
 * `.return()`-ed (best-effort, errors swallowed) to run the body's
 * `finally` blocks, then the abort surfaces as a throw for the outer
 * `Effect.tryPromise` to catch. A throw inside the body propagates the
 * same way.
 */
async function runBody<O>(
  execute: (
    input: unknown,
    ctx: StepContext<unknown, O>
  ) =>
    | Promise<O | Bail<unknown>>
    | AsyncGenerator<unknown, O | Bail<unknown>, unknown>,
  input: unknown,
  ctx: StepContext<unknown, O>,
  signal: AbortSignal,
  name: string
): Promise<O | Bail<unknown>> {
  const result = execute(input, ctx);
  // Promise/AsyncGenerator dispatch via the canonical predicate.
  if (typeof result === "object" && Symbol.asyncIterator in result) {
    const iter = result;
    try {
      while (true) {
        if (signal.aborted) {
          await iter.return(undefined as never).catch(() => undefined);
          throw new Error(`Step "${name}" aborted`);
        }
        const next = await iter.next();
        if (next.done) {
          return next.value;
        }
        ctx.write(next.value);
      }
    } catch (err) {
      await iter.return(undefined as never).catch(() => undefined);
      throw err;
    }
  }
  return await result;
}

// ── Executable ──

export class Executable<I = unknown, X extends BaseContext = BaseContext> {
  // ── Per-frame ──
  readonly input: I;
  readonly name: string;
  readonly path: readonly string[];
  readonly context: X;

  // ── Shared substrate ──
  readonly config: ExecutableConfig;
  readonly #controller: AbortController;
  readonly #resolutions: Ref.Ref<HashMap.HashMap<string, unknown>>;

  private constructor(args: {
    input: I;
    name: string;
    path: readonly string[];
    context: X;
    config: ExecutableConfig;
    controller: AbortController;
    resolutions: Ref.Ref<HashMap.HashMap<string, unknown>>;
  }) {
    this.input = args.input;
    this.name = args.name;
    this.path = args.path;
    this.context = args.context;
    this.config = args.config;
    this.#controller = args.controller;
    this.#resolutions = args.resolutions;
  }

  /**
   * Allocate a root Executable. `Scope`-managed so cancellation
   * finalizer aborts pending consumers on close.
   */
  static make<I, X extends BaseContext = BaseContext>(args: {
    readonly input: I;
    readonly name: string;
    readonly seed?: Omit<X, "name">;
    readonly config?: Partial<ExecutableConfig>;
  }): Effect.Effect<Executable<I, X>, never, Scope.Scope> {
    return Effect.gen(function* () {
      const controller = new AbortController();
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          if (!controller.signal.aborted) {
            controller.abort("scope-closed");
          }
        })
      );
      const resolutions = yield* Ref.make(HashMap.empty<string, unknown>());
      return new Executable<I, X>({
        config: { ...defaultConfig, ...args.config },
        context: { ...(args.seed ?? {}), name: args.name } as X,
        controller,
        input: args.input,
        name: args.name,
        path: [args.name],
        resolutions,
      });
    });
  }

  // ── Forking ──────────────────────────────────────────────────────────────

  /**
   * Build a child frame. Extends path, updates name and context,
   * swaps input if provided. Shares controller, resolutions, config.
   */
  fork<NewI = unknown>(args: {
    name: string;
    input?: NewI;
    config?: Partial<ExecutableConfig>;
  }): Executable<NewI, X> {
    // Config does NOT inherit down the fork graph.
    // A parent's timeout/retry applies only to its own frame, not its children.
    return new Executable({
      config: { blocking: false, maxAttempts: 1, ...args.config },
      context: { ...this.context, name: args.name },
      controller: this.#controller,
      input: resolveInput(args.input, this.input as unknown as NewI),
      name: args.name,
      path: [...this.path, args.name],
      resolutions: this.#resolutions,
    });
  }

  // ── Cancellation ─────────────────────────────────────────────────────────

  get aborted(): boolean {
    return this.#controller.signal.aborted;
  }

  get reason(): unknown {
    return this.#controller.signal.reason as unknown;
  }

  /** Hand-off for `fetch(url, { signal: rt.signal })` etc. */
  get signal(): AbortSignal {
    return this.#controller.signal;
  }

  abort(reason?: unknown): void {
    if (!this.#controller.signal.aborted) {
      this.#controller.abort(reason ?? "cancelled");
    }
  }

  /** Subscribe to cancellation; returns an unsubscribe. */
  onAbort(handler: (reason: unknown) => void): Unsubscribe {
    const signal = this.#controller.signal;
    // Wrap to isolate handler throw from poisoning other subscribers.
    const safe = (reason: unknown): void => {
      try {
        handler(reason);
      } catch {
        // Handler responsible for its own errors.
      }
    };
    if (signal.aborted) {
      queueMicrotask(() => {
        safe(signal.reason);
      });
      return () => undefined;
    }
    const onAbort = (): void => {
      safe(signal.reason);
    };
    signal.addEventListener("abort", onAbort);
    return () => {
      signal.removeEventListener("abort", onAbort);
    };
  }

  /** Effect-typed observation: fails with `"interrupted"` on abort. */
  get interrupted(): Effect.Effect<never, "interrupted"> {
    const ctl = this.#controller;
    return Effect.async<never, "interrupted">((resume) => {
      if (ctl.signal.aborted) {
        resume(Effect.fail("interrupted"));
        return;
      }
      const onAbort = () => {
        resume(Effect.fail("interrupted"));
      };
      ctl.signal.addEventListener("abort", onAbort);
      return Effect.sync(() => {
        ctl.signal.removeEventListener("abort", onAbort);
      });
    });
  }

  // ── Suspension ───────────────────────────────────────────────────────────

  /**
   * Effect-typed `suspend`: returns the recorded resolution if
   * present, otherwise fails with a {@link SuspendSignal}.
   * Resolutions are durable for the lifetime of the Run.
   */
  suspend<T>(args: SuspensionRequest, occurrence = 0): Effect.Effect<T, Error> {
    const ref = this.#resolutions;
    const originPath = [...this.path];
    const key = suspensionOccurrenceKey(originPath, args.name, occurrence);
    const request = args.request ?? args.meta ?? null;
    if (!Schema.is(JsonValueSchema)(request)) {
      return Effect.fail(
        new Error("Suspension request must be a finite, acyclic JSON value")
      );
    }
    return Effect.gen(function* () {
      const map = yield* Ref.get(ref);
      const exact = HashMap.get(map, key) as Option.Option<T>;
      if (Option.isSome(exact)) {
        return exact.value;
      }
      const existing = HashMap.get(map, args.name) as Option.Option<T>;
      if (Option.isSome(existing)) {
        return existing.value;
      }
      const suspension: SuspensionState = {
        name: args.name,
        reason: args.reason,
        ...(args.meta ? { meta: args.meta } : {}),
        kind: args.kind ?? "external",
        occurrence,
        request,
        stepPath: originPath,
        suspendedAt: new Date().toISOString(),
      };
      return yield* Effect.fail(new SuspendSignal(suspension, originPath));
    });
  }

  /** Deliver a resolution so the next replay of `suspend(name)` returns. */
  resolve(name: string, value: unknown): Effect.Effect<void> {
    return Ref.update(this.#resolutions, HashMap.set(name, value));
  }

  /** Deliver a value to one deterministic suspension occurrence. */
  resolveOccurrence(
    stepPath: readonly string[],
    name: string,
    occurrence: number,
    value: unknown
  ): Effect.Effect<void> {
    return Ref.update(
      this.#resolutions,
      HashMap.set(suspensionOccurrenceKey(stepPath, name, occurrence), value)
    );
  }

  // ── Driving ──────────────────────────────────────────────────────────────

  /**
   * The single execution engine. Runs `step` against `witness` for this
   * frame: publishes `step.started` per attempt, executes the body under
   * the merged retry/timeout policy (step metadata > config), and
   * publishes the terminal event (complete / failed / bailed / suspended).
   *
   * Two callers share it:
   *
   *   - **{@link Step.run}** passes `{ input, ctxExtension, stepMode: true }`.
   *     `stepMode` enables the Step-only hooks: pre-exec short-circuits,
   *     the pause gate, the post-body child cascade (`progress=100` +
   *     draining declared children), abort-failed suppression, and the
   *     `ctx.next` / `ctx.pipe` middleware affordances.
   *   - **Composer** (`ctx.invoke` / `parallel` / `race` / `branch` /
   *     `sequence`) passes no options — a lean synthetic frame.
   *
   * Attempt count lives in a local Ref, stamped on every event for
   * started/complete correlation across retries.
   */
  drive<O>(
    witness: Witness,
    step: Step<unknown, O>,
    opts?: DriveOptions<I>
  ): Effect.Effect<O | Bail<unknown>, Error> {
    const self = this;
    const stepMode = opts?.stepMode ?? false;
    const effectiveInput: unknown = resolveInput(opts?.input, self.input);

    // Drain this step's pending children in append order. `propagate=false`
    // (post-body cascade) swallows failures; `propagate=true` (ctx.next)
    // surfaces the first throw / bail / suspend. Eager-driven children
    // (status no longer "pending") are skipped to avoid double-runs.
    const drainChildren = (propagate: boolean): Effect.Effect<void, Error> =>
      Effect.gen(function* () {
        for (const child of step.children) {
          const stateNow = yield* step.snapshot.current;
          const persistedChild = stateNow.steps[child.path.join(".")];
          if (persistedChild && persistedChild.status !== "pending") {
            continue;
          }
          // Drive each child through the same engine in stepMode (its own
          // frame, pre-skip, cascade — equivalent to child.run()).
          const runChild = child.executable.drive(
            { channels: child.channels, composer: child.composer },
            child,
            { stepMode: true }
          );
          if (propagate) {
            const childResult = yield* runChild;
            if (isBail(childResult)) {
              return yield* Effect.fail(
                new StepBailError(child.name, childResult)
              );
            }
          } else {
            yield* runChild.pipe(Effect.catchAll(() => Effect.void));
          }
        }
      });

    const suspensionOccurrences = new Map<string, number>();

    // Single ctx builder. `next` / `pipe` are layered only in stepMode
    // (Composer frames omit them). Routes composition to the witness
    // composer (current frame) or the step's own composer.
    const buildCtx = (): StepContext<unknown, O> => {
      const base = {
        ...step.context,
        ...(opts?.ctxExtension ?? {}),
        branch: (
          predicate: (input: unknown) => boolean | Promise<boolean>,
          ifTrue: Step,
          ifFalse: Step,
          input: unknown,
          name?: string
        ) =>
          (witness.composer ?? step.composer).branch(
            predicate,
            ifTrue,
            ifFalse,
            input,
            name
          ),
        children: step.children,
        emit: step.emit.bind(step),
        fork: step.fork.bind(step),
        invoke: (child: Step, input: unknown, as?: string) =>
          (witness.composer ?? step.composer).invoke(child, input, as),
        log: step.log.bind(step),
        parallel: (specs: Record<string, ParallelEntry>, name?: string) =>
          (witness.composer ?? step.composer).parallel(specs, name),
        path: step.path,
        race: (specs: Record<string, ParallelEntry>, name?: string) =>
          (witness.composer ?? step.composer).race(specs, name),
        // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-parameters -- caller-supplied type for an ergonomic typed accessor over the untyped results map
        resultOf: <T = unknown>(name: string): T | undefined => {
          const state = Effect.runSync(step.snapshot.current);
          for (const key of lookupKeys(step.path, name)) {
            if (key in state.results) {
              return state.results[key] as T;
            }
          }
          return undefined;
        },
        get results() {
          return Effect.runPromise(step.snapshot.currentResults);
        },
        sequence: (
          steps: readonly Step[],
          initialInput: unknown,
          name?: string
        ) =>
          (witness.composer ?? step.composer).sequence(
            steps,
            initialInput,
            name
          ),
        signal: step.signal,
        get state() {
          return Effect.runPromise(step.snapshot.current);
        },
        statusOf: (name: string) => {
          const state = Effect.runSync(step.snapshot.current);
          for (const key of lookupKeys(step.path, name)) {
            const rec = state.steps[key];
            if (rec) {
              return rec.status;
            }
          }
        },
        step,
        get steps() {
          return Effect.runPromise(step.snapshot.currentSteps);
        },
        suspend: <T>(args: SuspensionRequest) => {
          const occurrence = suspensionOccurrences.get(args.name) ?? 0;
          suspensionOccurrences.set(args.name, occurrence + 1);
          return runEffectPromise(self.suspend<T>(args, occurrence));
        },
        get workflow() {
          return Effect.runPromise(step.snapshot.currentWorkflow);
        },
        write: step.write.bind(step),
        // Middleware affordances — Step-only (Composer frames omit them).
        ...(stepMode
          ? {
              next: () => runEffectPromise(drainChildren(true)),
              pipe: <T>(source: ReadableStream<T> | AsyncIterable<T>) =>
                step.pipe(source),
            }
          : {}),
      };
      // Composer frames omit `next`/`pipe`, so the object isn't a complete
      // StepContext structurally — one cast at the engine seam.
      return base as unknown as StepContext<unknown, O>;
    };

    return Effect.gen(function* () {
      // ── Pre-exec short-circuits (stepMode) ──
      // Skip / aborted / persisted-complete short-circuit without firing
      // started/complete. The transitioning event already moved status.
      if (stepMode) {
        if (step.status === "skipped") {
          return undefined as O;
        }
        if (step.aborted || step.status === "aborted") {
          return undefined as O;
        }
        // Skip-on-complete (recovery): a seeded snapshot may already mark
        // this path complete from a prior run — honor it, return the
        // persisted output. Only `complete` short-circuits.
        const persistedState = yield* step.snapshot.current;
        const persisted = persistedState.steps[step.path.join(".")];
        if (persisted?.status === "complete") {
          return persisted.output as O;
        }
      }

      const ctx = buildCtx();
      const attemptRef = yield* Ref.make(0);

      // Step metadata > executable config > package defaults.
      // resolveStepExecution applies package defaults; layer Executable.config for per-Run overrides.
      const stepPolicy = resolveStepExecution(step.config);
      const policy = {
        retry: stepPolicy.retry ?? self.config.retry,
        timeout: stepPolicy.timeout ?? self.config.timeout,
      };

      let timeoutMs: number | null = null;
      let configError: Error | null = null;
      if (policy.timeout !== undefined) {
        try {
          timeoutMs = parseDuration(policy.timeout);
        } catch (e) {
          configError = e instanceof Error ? e : new Error(String(e));
        }
      }

      const oneAttempt: Effect.Effect<O | Bail<unknown>, Error> = Effect.gen(
        function* () {
          // One-seam pause-check (stepMode) — every attempt parks here if
          // paused. `step.waitIfPaused()` resolves immediately when not.
          if (stepMode) {
            yield* Effect.promise(() => step.waitIfPaused());
          }
          const attempt = yield* Ref.updateAndGet(attemptRef, (n) => n + 1);

          witness.channels.started(self.path, self.name, attempt);

          const baseExec: Effect.Effect<O | Bail<unknown>, Error> = configError
            ? Effect.fail(configError)
            : Effect.tryPromise({
                catch: (e) => (e instanceof Error ? e : new Error(String(e))),
                try: () =>
                  runBody<O>(
                    // Bind so `this` inside a `function`-style body is the
                    // Step (the original method receiver), not undefined.
                    step.invoke.bind(step),
                    effectiveInput,
                    ctx,
                    step.signal,
                    step.name
                  ),
              });

          const withTimeout: Effect.Effect<O | Bail<unknown>, Error> =
            timeoutMs === null
              ? baseExec
              : baseExec.pipe(
                  Effect.timeoutFail({
                    duration: timeoutMs,
                    onTimeout: () =>
                      new Error(
                        `Step "${step.name}" timed out after ${String(policy.timeout)}`
                      ),
                  })
                );

          return yield* withTimeout;
        }
      );

      // Pin schedule type to avoid `any` leakage from cross-file toSchedule.
      const schedule: Schedule.Schedule<unknown> | null =
        configError === null && policy.retry ? toSchedule(policy.retry) : null;
      const withRetry: Effect.Effect<O | Bail<unknown>, Error> = schedule
        ? oneAttempt.pipe(
            Effect.retry({
              schedule,
              while: (error) => !isSuspendSignal(error),
            })
          )
        : oneAttempt;

      const result = yield* withRetry.pipe(
        Effect.tapError((err) =>
          Effect.gen(function* () {
            const attempt = yield* Ref.get(attemptRef);
            if (isSuspendSignal(err)) {
              if (
                err.originPath.length === self.path.length &&
                err.originPath.every((p, i) => p === self.path[i])
              ) {
                witness.channels.suspended(
                  self.path,
                  self.name,
                  attempt,
                  err.suspension
                );
              }
              return;
            }
            // Abort suppression: a mid-flight abort already fired
            // step.aborted; don't double-emit step.failed for the
            // abort-driven throw.
            if (self.aborted) {
              return;
            }
            witness.channels.failed(
              self.path,
              self.name,
              attempt,
              errorToShape(err)
            );
          })
        )
      );

      const finalAttempt = yield* Ref.get(attemptRef);
      if (isBail(result)) {
        witness.channels.bailed(
          self.path,
          self.name,
          finalAttempt,
          result.error
        );
        return result;
      }

      // Validate the completed result is JSON-serializable before the
      // terminal complete push (mirrors the pre-engine-merge #run guard).
      opts?.assertResult?.(result);

      // ── Post-body child cascade ──
      // Drain declared/forked children (fire-and-forget) before the
      // terminal complete. Unconditional so steps driven via Composer
      // (`ctx.invoke` / `parallel` / `race`) drain their declared
      // children too — not just the `.run()` path.
      yield* drainChildren(false);

      // Completion implies progress=100 (stepMode only; the setter
      // no-ops past terminal). Emitted before complete so a single
      // subscribe-and-take sees the final tick.
      if (stepMode) {
        step.progress = 100;
      }

      witness.channels.complete(self.path, self.name, finalAttempt, result);
      return result;
    });
  }
}
