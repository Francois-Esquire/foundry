import { isSuspendSignal } from "@foundry/workflows/executable";
import type { RunExecutionContext } from "@foundry/workflows/orchestrator";
import type { StepContext } from "@foundry/workflows/step";
import { Step } from "@foundry/workflows/step";

import { createLog } from "~/lib/log";

import type { Bindings } from "./bindings";
import { buildContext } from "./context";
import type {
  AnyDefinition,
  LockedNode,
  StepRecord,
  WorkflowRecord,
} from "./definition";
import { rootLock } from "./definition";
import type { Frame } from "./run-scope";
import { current, PAUSE_KIND, RunScope, raceAbort, runs } from "./run-scope";
import { validate } from "./schema";

/**
 * A locked tree becomes package Steps. Each node is a Step whose children
 * are declared on its spec, so they get real paths, skip-on-complete on
 * replay, and per-step chunk paths. The wrapper body drives the children
 * itself, collects their results by key, merges the literal input, and only
 * then calls the author's body. The package's post-body cascade finds no
 * pending children and does nothing.
 */

type Input = Readonly<Record<string, unknown>>;

function describe(definition: AnyDefinition, key: string): string {
  return definition.name ? `"${definition.name}"` : `"${key}"`;
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
  node: LockedNode,
  key: string,
  ctx: StepContext,
  scope: RunScope,
  bindings: Bindings
): Promise<unknown> {
  const frame = scope.frame(ctx.path);
  await scope.enter(frame);
  const results =
    node.mode === "parallel"
      ? await driveParallel(ctx.children, scope, frame)
      : await driveSeries(ctx.children);
  const merged: Input = { ...results, ...node.literal };
  const where = describe(node.definition, key);
  // A root's literal was parsed at launch; parsing it again would feed a
  // transform its own output.
  const input = (
    node.definition.input && !node.parsed
      ? await validate(node.definition.input, merged, `${where} input`)
      : merged
  ) as Input;
  if (node.definition.kind === "workflow") {
    throw new Error(
      `${where}: a workflow can only be the root of a run in phase 1`
    );
  }
  const definition = node.definition as StepRecord<Input, unknown>;
  const store = { cwd: scope.cwd, frame, scope };
  let output: unknown;
  let attempt: Promise<unknown> | undefined;
  try {
    attempt = current.run(store, () =>
      Promise.resolve(
        definition.fn(
          buildContext({ bindings, ctx, cwd: scope.cwd, frame, input, scope })
        )
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
      throw error;
    }
    // A host parked this step: what it opened is aborted, and the step
    // suspends instead of failing. Resuming replays the body from the top.
    // The name is unique per pause, so a later pause of the same step is
    // never answered by an earlier resolution.
    frame.paused = undefined;
    return await ctx.suspend({
      kind: PAUSE_KIND,
      name: `quirks.pause:${crypto.randomUUID().slice(0, 8)}`,
      reason: paused.reason,
      request: {},
    });
  }
  return definition.output
    ? await validate(definition.output, output, `${where} output`)
    : output;
}

/**
 * One package Step per locked node, children first. Each node's literal is
 * the one the run recorded for its path, so a recovered run executes
 * against the input it started with, not what a rebuilt tree would give.
 */
function materialize(
  fresh: LockedNode,
  key: string,
  scope: RunScope,
  bindings: Bindings,
  parent: readonly string[] = []
): Step<unknown, unknown> {
  const path = [...parent, key];
  const node: LockedNode = {
    ...fresh,
    literal: scope.literal(path, fresh.literal),
  };
  const children = node.children.map(([childKey, child]) =>
    materialize(child, childKey, scope, bindings, path)
  );
  return Step.create<unknown, unknown>({
    children,
    execute: (_input, ctx) =>
      runBody(node, key, ctx as StepContext, scope, bindings),
    // Explicit: an undefined input inherits the launcher's.
    input: node.literal,
    name: key,
  });
}

function requireName(definition: AnyDefinition): string {
  if (definition.name === undefined) {
    throw new Error("only named definitions can be launched");
  }
  return definition.name;
}

/** Adapt a named definition to the orchestrator's factory contract. */
export type DefinitionFactory = (
  input: unknown,
  execution?: RunExecutionContext
) => Promise<Step<unknown, unknown>>;

export function factoryFor(
  definition: AnyDefinition,
  bindings: () => Bindings
): DefinitionFactory {
  const name = requireName(definition);
  return async (rawInput, execution) => {
    const bound = bindings();
    // Parse before a scope exists: a rejected launch must leave nothing in
    // the run table.
    const input = (
      definition.input
        ? await validate(definition.input, rawInput ?? {}, `"${name}" input`)
        : (rawInput ?? {})
    ) as Input;
    const scope = new RunScope(
      execution?.runId ?? crypto.randomUUID(),
      bound.root,
      bound.host
    );
    try {
      const node = await rootNode(definition, name, input, scope, bound);
      const root = materialize(node, name, scope, bindings());
      scope.attach(root);
      return root;
    } catch (error) {
      runs.delete(scope.id);
      throw error;
    }
  };
}

async function rootNode(
  definition: AnyDefinition,
  name: string,
  input: Input,
  scope: RunScope,
  bindings: Bindings
): Promise<LockedNode> {
  if (definition.kind === "step") {
    return rootLock(definition, input);
  }
  const workflow = definition as WorkflowRecord<Input>;
  if (workflow.tree) {
    return workflow.tree;
  }
  if (!workflow.setup) {
    throw new Error(`"${name}": a workflow needs a tree or setup`);
  }
  const log = createLog((level, message) => bindings.log[level](message));
  const tree = await workflow.setup({ input, log, run: { id: scope.id } });
  if (!(typeof tree === "object" && tree !== null && tree.kind === "node")) {
    throw new Error(`"${name}": setup must return a locked node`);
  }
  return tree;
}
