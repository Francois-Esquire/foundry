import { isSuspendSignal } from "@foundry/workflows/executable";
import type { StepContext, StepSpec } from "@foundry/workflows/step";
import { Step } from "@foundry/workflows/step";
import type { RetryPolicy } from "@foundry/workflows/types";
import { isBail } from "@foundry/workflows/types";

import type { Bindings } from "./bindings";
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
import { parseEvery } from "./schedule";
import { notJson, validate } from "./schema";

type Input = Readonly<Record<string, unknown>>;

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
      setupCounters.exit(() =>
        Promise.resolve(
          definition.fn(buildContext({ bindings, ctx, frame, input, scope }))
        )
      )
    );
    output = await raceAbort(frame, attempt);
  } catch (error) {
    await attempt?.catch(() => undefined);
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
    return await ctx.suspend({
      kind: PAUSE_KIND,
      name: scope.pauseName(frame),
      reason: paused.reason,
      request: {},
    });
  } finally {
    clearTimeout(timer);
  }
  const result =
    definition.output && !isBail(output)
      ? await validate(definition.output, output, `${where} output`)
      : output;
  const problem = notJson(result);
  if (problem) {
    throw new Error(
      `${where} returned a value that is not JSON: ${problem}; return plain data (an ISO string for a date)`
    );
  }
  return result;
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
  const retry = asRunPolicy(scope.id, bindings, node.definition.config?.retry);
  return {
    children,
    ...(retry === undefined ? {} : { config: { retry } }),
    execute: (_input, ctx) =>
      asRunWork(scope.id, bindings, () =>
        runBody(node, key, ctx as StepContext, scope, bindings)
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
          stepTree(await rootNode(definition, name, input, scope, bound), name),
          name,
          scope,
          bound
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
