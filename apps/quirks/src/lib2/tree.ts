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
import { current, RunScope, raceAbort } from "./run-scope";
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

async function driveParallel(
  children: readonly Step[],
  detach: (runs: readonly Promise<unknown>[]) => void
): Promise<Record<string, unknown>> {
  const runs = children.map((child) => child.run());
  // Fail fast, but never leave a sibling's rejection unobserved.
  for (const run of runs) {
    run.catch(() => undefined);
  }
  detach(runs);
  const values = await Promise.all(runs);
  return Object.fromEntries(
    children.map((child, index) => [child.name, values[index]])
  );
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
      ? await driveParallel(ctx.children, (runs) => {
          frame.detached = runs;
        })
      : await driveSeries(ctx.children);
  frame.detached = [];
  const merged: Input = { ...results, ...node.literal };
  const where = describe(node.definition, key);
  const input = (
    node.definition.input
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
  const output = await raceAbort(
    frame,
    current.run(store, () =>
      Promise.resolve(
        definition.fn(
          buildContext({ bindings, ctx, cwd: scope.cwd, frame, input, scope })
        )
      )
    )
  );
  return definition.output
    ? await validate(definition.output, output, `${where} output`)
    : output;
}

/** One package Step per locked node, children first. */
export function materialize(
  node: LockedNode,
  key: string,
  scope: RunScope,
  bindings: Bindings
): Step<unknown, unknown> {
  const children = node.children.map(([childKey, child]) =>
    materialize(child, childKey, scope, bindings)
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
    const scope = new RunScope(
      execution?.runId ?? crypto.randomUUID(),
      bound.root
    );
    const input = (
      definition.input
        ? await validate(definition.input, rawInput ?? {}, `"${name}" input`)
        : (rawInput ?? {})
    ) as Input;
    const node = await rootNode(definition, name, input, scope, bound);
    const root = materialize(node, name, scope, bindings());
    scope.attach(root);
    return root;
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
