import type { Schedule, Scope } from "effect";

import { Effect, HashMap, Option, Ref } from "effect";
import { z } from "zod";
import {
  errorToShape,
  resolveInput,
  runEffectPromise,
} from "../effect-interop";
import { isJsonValue } from "../json-value";
import { parseDuration, toSchedule } from "../retry-schedule";
import type { Step, StepContext } from "../step";
import type { Bail, Duration, RetryPolicy, Unsubscribe } from "../types";
import { isBail, StepBailError } from "../types";
import type { Channels, SuspensionRequest, SuspensionState } from "./channels";
import type { Composer, ParallelEntry } from "./composer";

export interface BaseContext {
  readonly name: string;
}

export interface ExecutableConfig {
  readonly blocking: boolean;
  readonly maxAttempts: number;
  readonly retry?: RetryPolicy;
  readonly timeout?: Duration;
}

const defaultConfig: ExecutableConfig = {
  blocking: true,
  maxAttempts: 1,
};

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

export interface SuspensionOccurrence {
  readonly name: string;
  readonly occurrence: number;
  readonly stepPath: readonly string[];
}

const SuspensionOccurrenceKeySchema = z.tuple([
  z.array(z.string()),
  z.string(),
  z.number().int().nonnegative(),
]);

export function parseSuspensionOccurrenceKey(
  key: string
): SuspensionOccurrence | undefined {
  let decoded: unknown;
  try {
    decoded = JSON.parse(key);
  } catch {
    return;
  }
  const parsed = SuspensionOccurrenceKeySchema.safeParse(decoded);
  if (!parsed.success) {
    return;
  }
  const [stepPath, name, occurrence] = parsed.data;
  return { name, occurrence, stepPath };
}

export interface Witness {
  readonly channels: Channels;
  readonly composer?: Composer;
}

export interface DriveOptions<I> {
  readonly assertResult?: (value: unknown) => void;
  readonly ctxExtension?: object;
  readonly input?: I;
  readonly stepMode?: boolean;
}

function lookupKeys(
  path: readonly string[],
  name: string
): readonly [string, string] {
  const siblingNs = path.slice(0, -1).join(".");
  const siblingKey = siblingNs.length > 0 ? `${siblingNs}.${name}` : name;
  const childKey = path.length > 0 ? `${path.join(".")}.${name}` : name;
  return [siblingKey, childKey];
}

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
  if (typeof result === "object" && Symbol.asyncIterator in result) {
    const iter = result;
    try {
      for (;;) {
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

export class Executable<I = unknown, X extends BaseContext = BaseContext> {
  readonly input: I;
  readonly name: string;
  readonly path: readonly string[];
  readonly context: X;

  readonly config: ExecutableConfig;
  readonly #controller: AbortController;
  readonly #disarmScopeAbort: () => void;
  readonly #resolutions: Ref.Ref<HashMap.HashMap<string, unknown>>;

  private constructor(args: {
    input: I;
    name: string;
    path: readonly string[];
    context: X;
    config: ExecutableConfig;
    controller: AbortController;
    disarmScopeAbort: () => void;
    resolutions: Ref.Ref<HashMap.HashMap<string, unknown>>;
  }) {
    this.input = args.input;
    this.name = args.name;
    this.path = args.path;
    this.context = args.context;
    this.config = args.config;
    this.#controller = args.controller;
    this.#disarmScopeAbort = args.disarmScopeAbort;
    this.#resolutions = args.resolutions;
  }

  static make<Input, Context extends BaseContext = BaseContext>(args: {
    readonly input: Input;
    readonly name: string;
    readonly seed?: Omit<Context, "name">;
    readonly config?: Partial<ExecutableConfig>;
  }): Effect.Effect<Executable<Input, Context>, never, Scope.Scope> {
    return Effect.gen(function* () {
      const controller = new AbortController();
      let abortOnClose = true;
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          if (abortOnClose && !controller.signal.aborted) {
            controller.abort("scope-closed");
          }
        })
      );
      const resolutions = yield* Ref.make(HashMap.empty<string, unknown>());
      return new Executable<Input, Context>({
        config: { ...defaultConfig, ...args.config },
        context: { ...(args.seed ?? {}), name: args.name } as Context,
        controller,
        disarmScopeAbort: () => {
          abortOnClose = false;
        },
        input: args.input,
        name: args.name,
        path: [args.name],
        resolutions,
      });
    });
  }

  /** @internal */
  disarmScopeAbort(): void {
    this.#disarmScopeAbort();
  }

  fork<NewI = unknown>(args: {
    name: string;
    input?: NewI;
    config?: Partial<ExecutableConfig>;
  }): Executable<NewI, X> {
    return new Executable({
      config: { blocking: false, maxAttempts: 1, ...args.config },
      context: { ...this.context, name: args.name },
      controller: this.#controller,
      disarmScopeAbort: this.#disarmScopeAbort,
      input: resolveInput(args.input, this.input as unknown as NewI),
      name: args.name,
      path: [...this.path, args.name],
      resolutions: this.#resolutions,
    });
  }

  get aborted(): boolean {
    return this.#controller.signal.aborted;
  }

  get reason(): unknown {
    return this.#controller.signal.reason as unknown;
  }

  get signal(): AbortSignal {
    return this.#controller.signal;
  }

  abort(reason?: unknown): void {
    if (!this.#controller.signal.aborted) {
      this.#controller.abort(reason ?? "cancelled");
    }
  }

  onAbort(handler: (reason: unknown) => void): Unsubscribe {
    const { signal } = this.#controller;
    const safe = (reason: unknown): void => {
      try {
        handler(reason);
      } catch {
        // biome-ignore lint/complexity/noUselessReturn: End the best-effort operation on failure.
        return;
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

  suspend<T>(args: SuspensionRequest, occurrence = 0): Effect.Effect<T, Error> {
    const ref = this.#resolutions;
    const originPath = [...this.path];
    const key = suspensionOccurrenceKey(originPath, args.name, occurrence);
    const request = args.request ?? args.meta ?? null;
    if (!isJsonValue(request)) {
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

  resolve(name: string, value: unknown): Effect.Effect<void> {
    return Ref.update(this.#resolutions, HashMap.set(name, value));
  }

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

  drive<O>(
    witness: Witness,
    step: Step<unknown, O>,
    opts?: DriveOptions<I>
  ): Effect.Effect<O | Bail<unknown>, Error> {
    const self = this;
    const stepMode = opts?.stepMode ?? false;
    const effectiveInput: unknown = resolveInput(opts?.input, self.input);

    const drainChildren = (propagate: boolean): Effect.Effect<void, Error> =>
      Effect.gen(function* () {
        for (const child of step.children) {
          const stateNow = yield* step.snapshot.current;
          const persistedChild = stateNow.steps[child.path.join(".")];
          if (persistedChild && persistedChild.status !== "pending") {
            continue;
          }
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
        ...(stepMode
          ? {
              next: () => runEffectPromise(drainChildren(true)),
              pipe: <T>(source: ReadableStream<T> | AsyncIterable<T>) =>
                step.pipe(source),
            }
          : {}),
      };
      return base as unknown as StepContext<unknown, O>;
    };

    // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: This sequential execution state machine preserves pause, retry, cancellation, and lifecycle-event ordering in one Effect scope.
    return Effect.gen(function* () {
      if (stepMode) {
        if (step.status === "skipped") {
          return undefined as O;
        }
        if (step.aborted || step.status === "aborted") {
          return undefined as O;
        }
        const persistedState = yield* step.snapshot.current;
        const persisted = persistedState.steps[step.path.join(".")];
        if (persisted?.status === "complete") {
          return persisted.output as O;
        }
      } else {
        const seeded = witness.channels.snapshot.consumeSeeded(
          self.path.join(".")
        );
        if (seeded.found) {
          return seeded.output as O;
        }
      }

      const ctx = buildCtx();
      const attemptRef = yield* Ref.make(0);

      const policy = {
        retry: step.config.retry ?? self.config.retry,
        timeout: step.config.timeout ?? self.config.timeout,
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

      opts?.assertResult?.(result);

      yield* drainChildren(false);

      if (stepMode) {
        step.progress = 100;
      }

      witness.channels.complete(self.path, self.name, finalAttempt, result);
      return result;
    });
  }
}
