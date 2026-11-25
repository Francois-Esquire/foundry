import { current } from "~/lib/run-scope";
import type { RunRecord } from "~/lib/workflow-runs";
import type { ManagerArgs } from "../bindings";
import type { AnyDefinition, NamedDefinition } from "../definition";
import type { ExecutionRun } from "../execution-record";
import type { ExecutionStatus } from "../execution-statuses";
import { DEFINITION_IDENTITY } from "../handles";
import type { DefinitionLaunch, Launched } from "../launcher";

export interface RunView {
  readonly endedAt?: string;
  readonly error?: string;
  readonly id: string;
  readonly input?: unknown;
  readonly kind: "task" | "workflow";
  readonly name: string;
  readonly output?: unknown;
  readonly queuedAt: string;
  readonly startedAt?: string;
  readonly status: ExecutionStatus;
}

export interface RunQuery {
  readonly name?: string;
  readonly status?: ExecutionStatus | readonly ExecutionStatus[];
}

export interface Runs {
  get(runId: string): Promise<RunView | null>;
  launch(
    definition: AnyDefinition,
    input: unknown,
    options?: DefinitionLaunch
  ): Promise<Launched<unknown>>;
  list(query?: RunQuery): Promise<readonly RunView[]>;
  named(name: string): NamedDefinition | undefined;
}

export interface RunsSource {
  execution(runId: string): ExecutionRun | undefined;
  executions(): readonly ExecutionRun[];
  launch(
    definition: AnyDefinition,
    input: unknown,
    options?: DefinitionLaunch
  ): Promise<Launched<unknown>>;
  named(name: string): NamedDefinition | undefined;
  nameOf(name: string): string;
  resultOf(runId: string): Promise<unknown>;
  stored(runId: string): Promise<RunRecord | undefined>;
  storedAll(): Promise<readonly RunRecord[]>;
}

const LAUNCH_KIND = "launch";

interface RecordedLaunch {
  readonly definition: string;
  readonly run: string;
}

function definitionIdentity(definition: AnyDefinition): string {
  if (definition.name !== undefined) {
    return `name:${definition.name}`;
  }
  const constructed = (definition as { [DEFINITION_IDENTITY]?: string })[
    DEFINITION_IDENTITY
  ];
  return constructed === undefined ? "anon" : `anon:${constructed}`;
}

function isoOf(at: number | null | undefined): string | undefined {
  return at === null || at === undefined
    ? undefined
    : new Date(at).toISOString();
}

function runView(
  source: Pick<RunsSource, "nameOf">,
  id: string,
  stored: RunRecord | undefined,
  execution: ExecutionRun | undefined
): RunView | null {
  if (stored === undefined && execution === undefined) {
    return null;
  }
  const status: ExecutionStatus =
    stored?.status ?? execution?.status ?? "queued";
  const input = stored === undefined ? execution?.input : stored.input;
  const error = stored?.error?.message ?? execution?.error?.message;
  const queuedAt =
    execution?.timestamps.queuedAt ??
    isoOf(stored?.timestamps.createdAt) ??
    new Date(0).toISOString();
  const startedAt =
    execution?.timestamps.startedAt ?? isoOf(stored?.timestamps.startedAt);
  const endedAt =
    isoOf(stored?.timestamps.completedAt ?? stored?.timestamps.failedAt) ??
    execution?.timestamps.settledAt;
  return {
    ...(endedAt === undefined ? {} : { endedAt }),
    ...(error === undefined || status === "complete" ? {} : { error }),
    id,
    ...(input === undefined || input === null ? {} : { input }),
    kind: execution?.kind ?? "workflow",
    name: source.nameOf(stored?.step ?? execution?.name ?? ""),
    ...(status === "complete" && stored !== undefined
      ? { output: stored.output }
      : {}),
    queuedAt,
    ...(startedAt === undefined ? {} : { startedAt }),
    status,
  };
}

function matches(view: RunView, query: RunQuery): boolean {
  if (query.name !== undefined && view.name !== query.name) {
    return false;
  }
  if (query.status === undefined) {
    return true;
  }
  const wanted: readonly ExecutionStatus[] =
    typeof query.status === "string" ? [query.status] : query.status;
  return wanted.includes(view.status);
}

export function engineRuns(source: RunsSource): Runs {
  return {
    async get(runId) {
      return runView(
        source,
        runId,
        await source.stored(runId),
        source.execution(runId)
      );
    },
    launch: (definition, input, options) =>
      source.launch(definition, input, options),
    async list(query = {}) {
      const stored = new Map(
        (await source.storedAll()).map((record) => [record.id, record])
      );
      const executions = new Map(
        source.executions().map((run) => [run.id, run])
      );
      const ids = new Set([...executions.keys(), ...stored.keys()]);
      return [...ids]
        .flatMap((id) => {
          const view = runView(source, id, stored.get(id), executions.get(id));
          return view !== null && matches(view, query) ? [view] : [];
        })
        .sort((a, b) => a.queuedAt.localeCompare(b.queuedAt));
    },
    named: (name) => source.named(name),
  };
}

export function scopedRuns(source: RunsSource, args: ManagerArgs): Runs {
  const plain = engineRuns(source);
  return {
    ...plain,
    async launch(definition, input, options) {
      const { key } = args.scope.claim(args.frame, LAUNCH_KIND);
      const recorded = args.scope.ledger.get<RecordedLaunch>(key);
      const identity = definitionIdentity(definition);
      if (recorded !== undefined && recorded.definition === identity) {
        return { id: recorded.run, result: source.resultOf(recorded.run) };
      }
      const launched = await current.exit(() =>
        source.launch(definition, input, options)
      );
      args.scope.ledger.set(key, {
        definition: identity,
        run: launched.id,
      } satisfies RecordedLaunch);
      return launched;
    },
  };
}
