import { isSuspendSignal } from "@foundry/workflows/executable";
import type { StepContext, StepSpec } from "@foundry/workflows/step";
import { Step } from "@foundry/workflows/step";
import type { RetryPolicy } from "@foundry/workflows/types";
import { isBail } from "@foundry/workflows/types";

import type { Bindings } from "./bindings";
import { timeoutMs } from "./cadence";
import { asRun } from "./calling-run";
import { buildContext } from "./context";
import type {
  AnyDefinition,
  LockedNode,
  StepRecord,
  WorkflowRecord,
} from "./definition";
import { isLockedNode, rootLock } from "./definition";
import { withinContext } from "./execution-context";
import type { RunExecution } from "./run-queue";
import type { Frame, RunScope, RunScopes } from "./run-scope";
import {
  current,
  PAUSE_KIND,
  raceAbort,
  setupCounters,
  workingDirectory,
} from "./run-scope";
import { notJson, validate } from "./schema";

type Input = Readonly<Record<string, unknown>>;

type Nesting = readonly WorkflowRecord<Input>[];

const NESTED = "$workflow";

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

type Body =
  | { readonly kind: "step"; readonly step: StepRecord<Input, unknown> }
  | { readonly kind: "workflow"; readonly workflow: WorkflowRecord<Input> };

function bodyOf(definition: AnyDefinition, key: string): Body {
  if (isStep(definition)) {
    return { kind: "step", step: definition };
  }
  if (isWorkflow(definition)) {
    return { kind: "workflow", workflow: definition };
  }
  throw new Error(
    `${describe(definition, key)}: a node must lock a step or a workflow`
  );
}

function nestingOf(definition: AnyDefinition): Nesting {
  return isWorkflow(definition) ? [definition] : [];
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
  body: Body,
  key: string,
  ctx: StepContext,
  scope: RunScope,
  bindings: Bindings,
  nesting: Nesting
): Promise<unknown> {
  const frame = scope.frame(ctx.path);
  await scope.enter(frame);
  scope.offerResumePrompt(frame);
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
  const input = (
    definition.input && !node.parsed
      ? await validate(definition.input, merged, `${where} input`)
      : merged
  ) as Input;
  if (body.kind === "workflow") {
    const outcome = await settle(frame, ctx, scope, () =>
      current.exit(() =>
        runNested(
          body.workflow,
          key,
          input,
          ctx,
          scope,
          bindings,
          nesting,
          node.children.length
        )
      )
    );
    return "suspended" in outcome ? outcome.suspended : outcome.output;
  }
  const { step } = body;
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
  const timer = startTimeout(step, where, frame);
  let outcome: Attempt;
  try {
    outcome = await settle(frame, ctx, scope, () =>
      current.run(store, () =>
        setupCounters.exit(() =>
          Promise.resolve(
            step.fn(buildContext({ bindings, ctx, frame, input, scope }))
          )
        )
      )
    );
  } finally {
    clearTimeout(timer);
  }
  if ("suspended" in outcome) {
    return outcome.suspended;
  }
  const { output } = outcome;
  const result =
    step.output && !isBail(output)
      ? await validate(step.output, output, `${where} output`)
      : output;
  const problem = notJson(result);
  if (problem) {
    throw new Error(
      `${where} returned a value that is not JSON: ${problem}; return plain data (an ISO string for a date)`
    );
  }
  return result;
}

type Attempt = { readonly output: unknown } | { readonly suspended: unknown };

async function settle(
  frame: Frame,
  ctx: StepContext,
  scope: RunScope,
  work: () => Promise<unknown>
): Promise<Attempt> {
  let running: Promise<unknown> | undefined;
  try {
    running = work();
    return { output: await raceAbort(frame, running) };
  } catch (error) {
    await running?.catch(() => undefined);
    const { paused } = frame;
    if (!paused) {
      if (!isSuspendSignal(error)) {
        frame.failed = true;
        frame.controller.abort(error);
        await Promise.allSettled(frame.detached);
        frame.detached = [];
      }
      throw error;
    }
    frame.paused = undefined;
    return {
      suspended: await ctx.suspend({
        kind: PAUSE_KIND,
        name: scope.pauseName(frame),
        reason: paused.reason,
        request: {},
      }),
    };
  }
}

function nameOfNested(definition: WorkflowRecord<Input>, key: string): string {
  return definition.name ?? key;
}

async function runNested(
  definition: WorkflowRecord<Input>,
  key: string,
  input: Input,
  ctx: StepContext,
  scope: RunScope,
  bindings: Bindings,
  nesting: Nesting,
  declaredChildren: number
): Promise<unknown> {
  if (nesting.includes(definition)) {
    const chain = [...nesting, definition]
      .map((each) => `"${nameOfNested(each, key)}"`)
      .join(" → ");
    throw new Error(
      `${describe(definition, key)}: a workflow cannot be locked inside itself (${chain}); to recurse, call it with .run() from a step`
    );
  }
  const existing = ctx.children
    .slice(declaredChildren)
    .find((candidate) => candidate.name === NESTED);
  if (existing) {
    return await existing.run();
  }
  const tree = await setupTree(
    definition,
    nameOfNested(definition, key),
    input,
    scope,
    bindings
  );
  return await ctx
    .fork(
      materialize(tree, NESTED, scope, bindings, ctx.path, [
        ...nesting,
        definition,
      ])
    )
    .run();
}

async function runChild(
  definition: AnyDefinition,
  raw: unknown,
  parent: StepContext,
  scope: RunScope,
  frame: Frame,
  bindings: Bindings
): Promise<unknown> {
  frame.signal.throwIfAborted();
  const { key, occurrence } = scope.claim(frame, "step.run");
  const attempt = (await parent.steps)[parent.path.join(".")]?.attempt ?? 0;
  frame.signal.throwIfAborted();
  const name = `$run-${occurrence}-${attempt}`;
  const existing = parent.children.find((candidate) => candidate.name === name);
  if (existing) {
    return existing.run();
  }
  const input =
    scope.ledger.get<{ readonly input: Input }>(key)?.input ??
    (await childInput(definition, raw, describe(definition, name)));
  if (notJson(input) === undefined) {
    scope.ledger.set(key, { input });
  }
  const node = await rootNode(definition, name, input, scope, bindings);
  frame.signal.throwIfAborted();
  const child = parent.fork(
    materialize(node, name, scope, bindings, parent.path, nestingOf(definition))
  );
  return child.run();
}

async function childInput(
  definition: AnyDefinition,
  raw: unknown,
  where: string
): Promise<Input> {
  return (
    definition.input
      ? await validate(definition.input, raw ?? {}, `${where} input`)
      : (raw ?? {})
  ) as Input;
}

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

function materialize(
  fresh: LockedNode,
  key: string,
  scope: RunScope,
  bindings: Bindings,
  parent: readonly string[] = [],
  nesting: Nesting = []
): StepSpec<unknown, unknown> {
  const path = [...parent, key];
  const node: LockedNode = {
    ...fresh,
    literal: scope.literal(path, fresh.literal),
  };
  const body = bodyOf(node.definition, key);
  if (
    body.kind === "workflow" &&
    node.children.some(([childKey]) => childKey === NESTED)
  ) {
    throw new Error(
      `${describe(node.definition, key)}: child "${NESTED}" is reserved for nested workflows`
    );
  }
  const children = node.children.map(([childKey, child]) =>
    materialize(child, childKey, scope, bindings, path, nesting)
  );
  const retry =
    body.kind === "step"
      ? asRunPolicy(scope.id, bindings, body.step.config?.retry)
      : undefined;
  return {
    children,
    ...(retry === undefined ? {} : { config: { retry } }),
    execute: (_input, ctx) =>
      asRunWork(scope.id, bindings, () =>
        runBody(node, body, key, ctx as StepContext, scope, bindings, nesting)
      ),
    input: node.literal,
    name: key,
  };
}

function asRunPolicy(
  runId: string,
  bindings: Bindings,
  retry: RetryPolicy | undefined
): RetryPolicy | undefined {
  const decide = retry?.shouldRetry;
  if (retry === undefined || decide === undefined) {
    return retry;
  }
  return {
    ...retry,
    shouldRetry: (error, attempt) =>
      asRunWork(runId, bindings, () => decide(error, attempt)),
  };
}

function asRunWork<T>(runId: string, bindings: Bindings, work: () => T): T {
  return withinContext(bindings.context, () => asRun(runId, work));
}

export type DefinitionFactory = (
  input: unknown,
  execution?: RunExecution
) => Promise<Step<unknown, unknown>>;

export function factoryFor(
  definition: AnyDefinition,
  bindings: () => Bindings,
  scopes: RunScopes,
  name: string = nameOf(definition)
): DefinitionFactory {
  return (rawInput, execution) => {
    const bound = bindings();
    const runId = execution?.runId ?? crypto.randomUUID();
    return asRunWork(runId, bound, () =>
      openRun(definition, name, scopes, bound, rawInput, {
        ...execution,
        runId,
      })
    );
  };
}

async function openRun(
  definition: AnyDefinition,
  name: string,
  scopes: RunScopes,
  bound: Bindings,
  rawInput: unknown,
  { resolutions, runId }: RunExecution
): Promise<Step<unknown, unknown>> {
  const input = (
    definition.input
      ? await validate(definition.input, rawInput ?? {}, `"${name}" input`)
      : (rawInput ?? {})
  ) as Input;
  return await scopes.open(
    runId,
    bound.context?.cwd ?? bound.root,
    bound.host,
    async (scope) =>
      Step.create(
        materialize(
          await rootNode(definition, name, input, scope, bound),
          name,
          scope,
          bound,
          [],
          nestingOf(definition)
        )
      ),
    resolutions
  );
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
  return await setupTree(definition, name, input, scope, bindings);
}

async function setupTree(
  definition: WorkflowRecord<Input>,
  name: string,
  input: Input,
  scope: RunScope,
  bindings: Bindings
): Promise<LockedNode> {
  const tree: unknown = await setupCounters.run(new Map(), () =>
    definition.setup({
      input,
      log:
        bindings.setupLog?.({ id: scope.id, workflow: name }) ?? bindings.log,
      run: { id: scope.id },
    })
  );
  if (!isLockedNode(tree)) {
    throw new Error(`"${name}": setup must return a locked node`);
  }
  return tree;
}
