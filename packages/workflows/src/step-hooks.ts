import type { SuspensionState } from "./channels";
import type { BaseContext, ExecutableConfig } from "./executable";
import { isSuspendSignal } from "./executable";
import type { StepSnapshot } from "./snapshot";
import type { StepContext, StepSpec } from "./step";
import { Step, StepBailError } from "./step";

type HookExecution<I, X extends BaseContext> = (
  input: I,
  ctx: StepContext<I, unknown, X>
) => Promise<unknown> | AsyncGenerator<unknown, unknown, unknown>;

interface NamedStepHook<I, X extends BaseContext> {
  readonly config?: Partial<ExecutableConfig>;
  readonly execute: HookExecution<I, X>;
  readonly name: string;
}

/** A Step executed before the target body with the target input. */
export type BeforeStepHook<
  I = unknown,
  X extends BaseContext = BaseContext,
> = NamedStepHook<I, X>;

/** Read-only input delivered to a successful-body hook. */
export type AfterSuccessStepHookInput<I = unknown, O = unknown> = Readonly<{
  input: I;
  output: O;
}>;

/** A Step executed after the target body completes successfully. */
export type AfterSuccessStepHook<
  I = unknown,
  O = unknown,
  X extends BaseContext = BaseContext,
> = NamedStepHook<AfterSuccessStepHookInput<I, O>, X>;

/** Read-only input delivered to a terminal-body-failure hook. */
export type AfterFailureStepHookInput<I = unknown> = Readonly<{
  input: I;
  error: Error;
}>;

/** A Step executed after the target body exhausts its retry policy. */
export type AfterFailureStepHook<
  I = unknown,
  X extends BaseContext = BaseContext,
> = NamedStepHook<AfterFailureStepHookInput<I>, X>;

/** Read-only input delivered when the target body suspends. */
export type AfterSuspensionStepHookInput<I = unknown> = Readonly<{
  input: I;
  suspension: SuspensionState;
  occurrence: number;
}>;

/** A Step executed after one deterministic target-body suspension occurrence. */
export type AfterSuspensionStepHook<
  I = unknown,
  X extends BaseContext = BaseContext,
> = NamedStepHook<AfterSuspensionStepHookInput<I>, X>;

/** Opt-in hooks around one semantic target Step. */
export interface StepHooks<
  I = unknown,
  O = unknown,
  X extends BaseContext = BaseContext,
> {
  readonly after?: {
    readonly success?: readonly AfterSuccessStepHook<I, O, X>[];
    readonly failure?: readonly AfterFailureStepHook<I, X>[];
    readonly suspension?: readonly AfterSuspensionStepHook<I, X>[];
  };
  readonly before?: readonly BeforeStepHook<I, X>[];
}

const bodyPhaseName = "@body";
const beforePhaseName = "@before";
const afterPhaseName = "@after";

function validateBranch(
  branch: string,
  hooks: readonly { readonly name: string }[]
): void {
  const names = new Set<string>();
  for (const hook of hooks) {
    if (
      hook.name.length === 0 ||
      hook.name.trim() !== hook.name ||
      hook.name.startsWith("@")
    ) {
      throw new Error(
        `Invalid Step hook name "${hook.name}" in ${branch}: names must be non-empty, have no surrounding whitespace, and cannot begin with reserved "@"`
      );
    }
    if (names.has(hook.name)) {
      throw new Error(`Duplicate Step hook name "${hook.name}" in ${branch}`);
    }
    names.add(hook.name);
  }
}

function validateHooks<I, O, X extends BaseContext>(
  hooks: StepHooks<I, O, X>
): void {
  validateBranch("before", hooks.before ?? []);
  validateBranch("after.success", hooks.after?.success ?? []);
  validateBranch("after.failure", hooks.after?.failure ?? []);
  validateBranch("after.suspension", hooks.after?.suspension ?? []);
}

function hookSpec<I, X extends BaseContext>(
  hook: NamedStepHook<I, X>,
  input: I
): StepSpec<I, unknown, X> {
  return {
    execute: hook.execute,
    input,
    name: hook.name,
    ...(hook.config === undefined ? {} : { config: hook.config }),
  };
}

function asChildSpec(spec: StepSpec): StepSpec {
  return spec;
}

function requiredChild(children: readonly Step[], name: string): Step {
  const child = children.find((candidate) => candidate.name === name);
  if (!child) {
    throw new Error(`Missing reserved Step hook phase "${name}"`);
  }
  return child;
}

function snapshotError(record: StepSnapshot): Error | null {
  if (record.error) {
    const error = (() => {
      switch (record.error.name) {
        case "EvalError":
          return new EvalError(record.error.message);
        case "RangeError":
          return new RangeError(record.error.message);
        case "ReferenceError":
          return new ReferenceError(record.error.message);
        case "SyntaxError":
          return new SyntaxError(record.error.message);
        case "TypeError":
          return new TypeError(record.error.message);
        case "URIError":
          return new URIError(record.error.message);
        default:
          return new Error(record.error.message);
      }
    })();
    error.name = record.error.name;
    if (record.error.stack) {
      error.stack = record.error.stack;
    }
    return error;
  }
  if (record.bail !== undefined) {
    return new StepBailError(bodyPhaseName, {
      _bail: true,
      error: record.bail,
    });
  }
  return null;
}

function attachCause(error: Error, cause: Error): Error {
  if (error.cause === undefined) {
    Object.defineProperty(error, "cause", {
      configurable: true,
      value: cause,
    });
  }
  return error;
}

async function runHookBranch<RootI, RootO, I, X extends BaseContext>(
  ctx: StepContext<RootI, RootO, X>,
  branchName: string,
  input: I,
  hooks: readonly NamedStepHook<I, X>[],
  cause?: Error
): Promise<void> {
  if (hooks.length === 0) {
    return;
  }

  const after = ctx.fork<I, void>({
    execute: async (afterInput, afterContext) => {
      const branch = afterContext.fork<I, void>({
        children: hooks.map((hook) =>
          asChildSpec(hookSpec(hook, afterInput) as unknown as StepSpec)
        ),
        execute: async (branchInput, branchContext) => {
          for (const child of branchContext.children) {
            await child.run(branchInput);
          }
        },
        input: afterInput,
        name: branchName,
      });
      await branch.run(afterInput);
      // Terminal body outcomes deliberately keep @after replayable. A failed
      // body may need its completed hook branch recovered, and one body can
      // suspend at later occurrences after an earlier occurrence's hook
      // branch completed.
      if (cause) {
        throw cause;
      }
    },
    input,
    name: afterPhaseName,
  });

  try {
    await after.run(input);
  } catch (error) {
    if (cause && error === cause) {
      return;
    }
    if (cause && error instanceof Error) {
      throw attachCause(error, cause);
    }
    throw error;
  }
}

/**
 * Compose opt-in before/outcome hooks around one ordinary StepSpec.
 *
 * Every phase is a real Step. The returned Step retains the target's public
 * name, input/output types, seed, and stable root id while the target body
 * executes at the reserved `@body` child path with its own execution config.
 */
export function withStepHooks<I, O, X extends BaseContext = BaseContext>(
  target: StepSpec<I, O, X>,
  hooks: StepHooks<I, O, X>
): Step<I, O, X> {
  validateHooks(hooks);

  const beforeHooks = hooks.before ?? [];
  const successHooks = hooks.after?.success ?? [];
  const failureHooks = hooks.after?.failure ?? [];
  const suspensionHooks = hooks.after?.suspension ?? [];

  const children: StepSpec[] = [];
  if (beforeHooks.length > 0) {
    children.push({
      children: beforeHooks.map((hook) =>
        asChildSpec(hookSpec(hook, target.input) as unknown as StepSpec)
      ),
      execute: async (input, ctx) => {
        for (const child of ctx.children) {
          await child.run(input);
        }
      },
      input: target.input,
      name: beforePhaseName,
    });
  }
  children.push(
    asChildSpec({
      execute: target.execute,
      input: target.input,
      name: bodyPhaseName,
      ...(target.children === undefined ? {} : { children: target.children }),
      ...(target.config === undefined ? {} : { config: target.config }),
    } as unknown as StepSpec)
  );

  return Step.create<I, O, X>({
    input: target.input,
    name: target.name,
    ...(target.id === undefined ? {} : { id: target.id }),
    ...(target.seed === undefined ? {} : { seed: target.seed }),
    children,
    execute: async (input, ctx) => {
      if (beforeHooks.length > 0) {
        await requiredChild(ctx.children, beforePhaseName).run(input);
      }

      const body = requiredChild(ctx.children, bodyPhaseName);
      const bodyKey = [...ctx.path, bodyPhaseName].join(".");
      const persistedBody = (await ctx.steps)[bodyKey];
      let output: O;

      try {
        const persistedError =
          persistedBody?.status === "failed"
            ? snapshotError(persistedBody)
            : null;
        if (persistedError) {
          throw persistedError;
        }
        output = (await body.run(input)) as O;
      } catch (error) {
        if (isSuspendSignal(error)) {
          const occurrence = error.suspension.occurrence ?? 0;
          await runHookBranch(
            ctx,
            `suspension:${occurrence}`,
            Object.freeze({
              input,
              occurrence,
              suspension: error.suspension,
            }),
            suspensionHooks,
            error
          );
          throw error;
        }

        const bodyError =
          error instanceof Error ? error : new Error(String(error));
        await runHookBranch(
          ctx,
          "failure",
          Object.freeze({ error: bodyError, input }),
          failureHooks,
          bodyError
        );
        throw bodyError;
      }

      await runHookBranch(
        ctx,
        "success",
        Object.freeze({ input, output }),
        successHooks
      );
      return output;
    },
  });
}
