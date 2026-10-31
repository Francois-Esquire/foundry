import { isSuspendSignal } from "@foundry/workflows/executable";
import type { RunExecutionContext } from "@foundry/workflows/orchestrator";
import type { StepContext, StepSpec } from "@foundry/workflows/step";
import { Step } from "@foundry/workflows/step";
import { isBail } from "@foundry/workflows/types";

import type { Bindings } from "./bindings";
import { buildContext } from "./context";
import type {
  AnyDefinition,
  LockedNode,
  StepRecord,
  WorkflowRecord,
} from "./definition";
import { isLockedNode, rootLock } from "./definition";
import type { Frame, RunScope, RunScopes } from "./run-scope";
import { current, PAUSE_KIND, raceAbort, workingDirectory } from "./run-scope";
import { parseEvery } from "./schedule";
import { notJson, validate } from "./schema";

/**
 * A locked tree becomes package Steps. Each node is a Step whose children
 * are declared on its spec, so they get real paths, skip-on-complete on
 * replay, and per-step chunk paths. The wrapper body drives the children
 * itself, collects their results by key, merges the literal input, and only
 * then calls the author's body. The package's post-body cascade finds no
 * pending children and does nothing.
 */

type Input = Readonly<Record<string, unknown>>;

/** A node a run executes: a step, with steps all the way down. */
interface StepNode extends LockedNode {
  readonly children: readonly (readonly [string, StepNode])[];
  readonly definition: StepRecord<Input, unknown>;
}

function describe(definition: AnyDefinition, key: string): string {
  return definition.name ? `"${definition.name}"` : `"${key}"`;
}

function isStep(
  definition: AnyDefinition
): definition is StepRecord<Input, unknown> {
  return definition.kind === "step";
}

function isWorkflow(
  definition: AnyDefinition
): definition is WorkflowRecord<Input> {
  return definition.kind === "workflow";
}

/**
 * Check the whole tree before any of it runs: a workflow is a run's root
 * and its setup builds the tree, so a workflow node inside that tree has
 * nothing that could execute it.
 */
function stepTree(node: LockedNode, key: string): StepNode {
  const { definition } = node;
  if (!isStep(definition)) {
    throw new Error(
      `${describe(definition, key)}: a workflow can only be the root of a run, not a node in its tree`
    );
  }
  return {
    ...node,
    children: node.children.map(([childKey, child]) => [
      childKey,
      stepTree(child, childKey),
    ]),
    definition,
  };
}

async function driveSeries(
  children: readonly Step[]
): Promise<Record<string, unknown>> {
  const results: Record<string, unknown> = {};
  for (const child of children) {
    results[child.name] = await child.run();
  }
  return results;
}

/**
 * Run the children together. A child that parks (an ask, a pause) parks the
 * parent with it; the siblings keep running detached and the parent's
 * re-entry awaits them. The first real failure fails the parent, and with it
 * the run, so the siblings are aborted through the run scope and awaited
 * before the error travels up: nothing keeps executing after the run has
 * been reported failed, and the scope settles after every body has stopped.
 */
async function driveParallel(
  children: readonly Step[],
  scope: RunScope,
  frame: Frame
): Promise<Record<string, unknown>> {
  const pending = children.map((child) => child.run());
  for (const run of pending) {
    run.catch(() => undefined);
  }
  frame.detached = pending;
  try {
    const values = await Promise.all(pending);
    frame.detached = [];
    return Object.fromEntries(
      children.map((child, index) => [child.name, values[index]])
    );
  } catch (error) {
    if (isSuspendSignal(error)) {
      throw error;
    }
    scope.abort(error);
    await Promise.allSettled(pending);
    frame.detached = [];
    throw error;
  }
}

async function runBody(
  node: StepNode,
  key: string,
  ctx: StepContext,
  scope: RunScope,
  bindings: Bindings
): Promise<unknown> {
  const frame = scope.frame(ctx.path);
  await scope.enter(frame);
  const results =
    node.mode === "parallel"
      ? await driveParallel(
          ctx.children.slice(0, node.children.length),
          scope,
          frame
        )
      : await driveSeries(ctx.children.slice(0, node.children.length));
  const merged: Input = { ...results, ...node.literal };
  const { definition } = node;
  const where = describe(definition, key);
  // A root's literal was parsed at launch; parsing it again would feed a
  // transform its own output.
  const input = (
    definition.input && !node.parsed
      ? await validate(definition.input, merged, `${where} input`)
      : merged
  ) as Input;
  const store = {
    bindings,
    cwd: workingDirectory(scope.cwd),
    frame,
    run: (called: AnyDefinition, raw: unknown) => {
      const pending = runChild(called, raw, ctx, scope, frame, bindings);
      frame.detached = [...frame.detached, pending];
      pending.catch(() => undefined);
      return pending;
    },
    scope,
    write: (value: unknown) => ctx.write(value),
  };
  let output: unknown;
  let attempt: Promise<unknown> | undefined;
  const timer = startTimeout(definition, where, frame);
  try {
    attempt = current.run(store, () =>
      Promise.resolve(
        definition.fn(buildContext({ bindings, ctx, frame, input, scope }))
      )
    );
    output = await raceAbort(frame, attempt);
  } catch (error) {
    // Whatever ended the attempt (a throw, a cancellation, a sibling's
    // failure, a pause), the attempt has to stop before the step reports
    // it, so nothing runs after the run reads as failed or suspended: owned
    // calls reject at the abort, and a body that ignores its signal delays
    // the report until it returns.
    await attempt?.catch(() => undefined);
    const { paused } = frame;
    if (!paused) {
      // A failure, not a suspension that resumes into a replay: a retry
      // enters next, if the step has one, and must not replay this attempt.
      if (!isSuspendSignal(error)) {
        frame.failed = true;
        frame.controller.abort(error);
        await Promise.allSettled(frame.detached);
        frame.detached = [];
      }
      throw error;
    }
    // A host parked this step: what it opened is aborted, and the step
    // suspends instead of failing. Resuming replays the body from the top.
    // The name is unique per pause, so a later pause of the same step is
    // never answered by an earlier resolution.
    frame.paused = undefined;
    return await ctx.suspend({
      kind: PAUSE_KIND,
      name: `marbles.pause:${crypto.randomUUID().slice(0, 8)}`,
      reason: paused.reason,
      request: {},
    });
  } finally {
    clearTimeout(timer);
  }
  // A bail is a value the package handles; it never matches an output schema.
  const result =
    definition.output && !isBail(output)
      ? await validate(definition.output, output, `${where} output`)
      : output;
  const problem = notJson(result);
  if (problem) {
    // Recorded and handed to the parent as JSON: say so rather than let a
    // Date or a class instance change on the way.
    throw new Error(
      `${where} returned a value that is not JSON: ${problem}; return plain data (an ISO string for a date)`
    );
  }
  return result;
}

/** Dynamic calls share their parent's snapshot, channels, suspensions, and scope. */
async function runChild(
  definition: AnyDefinition,
  raw: unknown,
  parent: StepContext,
  scope: RunScope,
  frame: Frame,
  bindings: Bindings
): Promise<unknown> {
  frame.signal.throwIfAborted();
  const { occurrence } = scope.claim(frame, "step.run");
  const attempt = (await parent.steps)[parent.path.join(".")]?.attempt ?? 0;
  frame.signal.throwIfAborted();
  const name = `$run-${occurrence}-${attempt}`;
  const existing = parent.children.find((candidate) => candidate.name === name);
  if (existing) {
    return existing.run();
  }
  const input = (
    definition.input
      ? await validate(
          definition.input,
          raw ?? {},
          `${describe(definition, name)} input`
        )
      : (raw ?? {})
  ) as Input;
  const node = stepTree(
    await rootNode(definition, name, input, scope, bindings),
    name
  );
  frame.signal.throwIfAborted();
  const child = parent.fork(
    materialize(node, name, scope, bindings, parent.path)
  );
  return child.run();
}

/** A step's timeout as milliseconds. */
export function timeoutMs(timeout: number | string): number {
  if (typeof timeout === "number") {
    if (!(Number.isSafeInteger(timeout) && timeout > 0)) {
      throw new Error(
        `a timeout must be a positive number of milliseconds, not ${timeout}`
      );
    }
    return timeout;
  }
  return parseEvery(timeout);
}

/**
 * Abort the attempt's signal when the step's timeout passes, so the body
 * and everything it opened stop, and the attempt fails with the timeout.
 */
function startTimeout(
  definition: StepRecord,
  where: string,
  frame: Frame
): ReturnType<typeof setTimeout> | undefined {
  const timeout = definition.config?.timeout;
  if (timeout === undefined) {
    return;
  }
  const { controller } = frame;
  return setTimeout(() => {
    controller.abort(new Error(`${where} timed out after ${String(timeout)}`));
  }, timeoutMs(timeout));
}

/**
 * One package Step per locked node, children first. Each node's literal is
 * the one the run recorded for its path, so a recovered run executes
 * against the input it started with, not what a rebuilt tree would give.
 */
function materialize(
  fresh: StepNode,
  key: string,
  scope: RunScope,
  bindings: Bindings,
  parent: readonly string[] = []
): StepSpec<unknown, unknown> {
  const path = [...parent, key];
  const node: StepNode = {
    ...fresh,
    literal: scope.literal(path, fresh.literal),
  };
  const children = node.children.map(([childKey, child]) =>
    materialize(child, childKey, scope, bindings, path)
  );
  const retry = node.definition.config?.retry;
  return {
    children,
    // Retry only: the timeout is Marbles', since it must abort the body.
    ...(retry === undefined ? {} : { config: { retry } }),
    execute: (_input, ctx) =>
      runBody(node, key, ctx as StepContext, scope, bindings),
    // Explicit: an undefined input inherits the launcher's.
    input: node.literal,
    name: key,
  };
}

/** Adapt a named definition to the orchestrator's factory contract. */
export type DefinitionFactory = (
  input: unknown,
  execution?: RunExecutionContext
) => Promise<Step<unknown, unknown>>;

/**
 * Each run's scope is opened in `scopes`, which holds it only once its tree
 * is built: a launch rejected on its input or by its setup leaves nothing
 * in the run table. `name` is the root's key, the definition's own name
 * unless one is given for a nameless definition run directly.
 */
export function factoryFor(
  definition: AnyDefinition,
  bindings: () => Bindings,
  scopes: RunScopes,
  name: string = nameOf(definition)
): DefinitionFactory {
  return async (rawInput, execution) => {
    const bound = bindings();
    const input = (
      definition.input
        ? await validate(definition.input, rawInput ?? {}, `"${name}" input`)
        : (rawInput ?? {})
    ) as Input;
    return await scopes.open(
      execution?.runId ?? crypto.randomUUID(),
      bound.root,
      bound.host,
      async (scope) =>
        Step.create(
          materialize(
            stepTree(
              await rootNode(definition, name, input, scope, bound),
              name
            ),
            name,
            scope,
            bound
          )
        )
    );
  };
}

function nameOf(definition: AnyDefinition): string {
  if (definition.name === undefined) {
    throw new Error("a nameless definition needs a key to run as a root");
  }
  return definition.name;
}

async function rootNode(
  definition: AnyDefinition,
  name: string,
  input: Input,
  scope: RunScope,
  bindings: Bindings
): Promise<LockedNode> {
  if (!isWorkflow(definition)) {
    return rootLock(definition, input);
  }
  const tree: unknown = await definition.setup({
    input,
    log: bindings.setupLog?.({ id: scope.id, workflow: name }) ?? bindings.log,
    run: { id: scope.id },
  });
  if (!isLockedNode(tree)) {
    throw new Error(`"${name}": setup must return a locked node`);
  }
  return tree;
}
