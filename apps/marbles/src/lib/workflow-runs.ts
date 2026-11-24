import type { JsonValue } from "@foundry/lib/json";
import {
  type Job,
  type JobId,
  type QueueEvent,
  type Run,
  type RunId,
  type RunState,
  StoreError,
  WriteConflictError,
} from "@foundry/queue";
import type { QueueStoreService } from "@foundry/queue/store";
import {
  type WorkflowCheckpoint,
  WorkflowCheckpointSchema,
} from "@foundry/workflows/queue-handler";
import { WorkflowSnapshotSchema } from "@foundry/workflows/snapshot";
import { Cause, Effect, Exit } from "effect";
import { z } from "zod";
import { storableJson } from "~/lib/state/json";

const RUN_STATUSES = [
  "queued",
  "running",
  "suspended",
  "complete",
  "failed",
  "cancelled",
] as const;

export type RunStatus = (typeof RUN_STATUSES)[number];

export const isJsonValue = (value: unknown): value is JsonValue => {
  try {
    storableJson("a run record", value);
    return true;
  } catch {
    return false;
  }
};

const JSON_VALUE = "Expected a finite, acyclic JSON value";

const json = z.custom<JsonValue>(isJsonValue, JSON_VALUE);

const jsonSafe = z.custom<unknown>(isJsonValue, JSON_VALUE);

const ErrorShapeSchema = z.object({
  message: z.string(),
  name: z.string(),
  stack: z.string().optional(),
});

const DefinitionReferenceSchema = z.object({
  name: z.string(),
  version: z.string().optional(),
});

const RunLinksSchema = z.object({
  invocationId: z.string().optional(),
  jobId: z.string().optional(),
  parentRunId: z.string().optional(),
  principalId: z.string().optional(),
  sessionId: z.string().optional(),
  subjectId: z.string().optional(),
});

export const RunRecordSchema = z.object({
  definition: DefinitionReferenceSchema.optional(),
  error: ErrorShapeSchema.nullable(),
  extensions: z.record(z.string(), json),
  id: z.string(),
  input: jsonSafe,
  links: RunLinksSchema.optional(),
  metadata: z.record(z.string(), jsonSafe),
  output: jsonSafe,
  queueId: z.string(),
  snapshot: WorkflowSnapshotSchema.extend({ input: jsonSafe }),
  status: z.enum(RUN_STATUSES),
  step: z.string(),
  tags: z.record(z.string(), z.string()),
  timestamps: z.object({
    completedAt: z.number().nullable(),
    createdAt: z.number(),
    failedAt: z.number().nullable(),
    startedAt: z.number().nullable(),
  }),
});

export type RunRecord = z.infer<typeof RunRecordSchema>;

const STATUS: Readonly<Record<RunState["kind"], RunStatus>> = {
  cancelled: "cancelled",
  complete: "complete",
  failed: "failed",
  interrupted: "failed",
  queued: "queued",
  running: "running",
  suspended: "suspended",
};

export const runStatusOf = (state: RunState): RunStatus => STATUS[state.kind];

const errorOf = (state: RunState): RunRecord["error"] => {
  if (state.kind === "failed") {
    return state.error;
  }
  return state.kind === "interrupted"
    ? { message: state.reason, name: "interrupted" }
    : null;
};

const endedAt = (state: RunState, kinds: readonly RunState["kind"][]) => {
  if (!kinds.includes(state.kind)) {
    return null;
  }
  switch (state.kind) {
    case "complete":
      return state.completedAt;
    case "cancelled":
      return state.cancelledAt;
    case "failed":
      return state.failedAt;
    case "interrupted":
      return state.interruptedAt;
    default:
      return null;
  }
};

const timestampsOf = (
  job: Job,
  { startedAt, state }: Run
): RunRecord["timestamps"] => ({
  completedAt: endedAt(state, ["complete", "cancelled"]),
  createdAt: job.createdAt,
  failedAt: endedAt(state, ["failed", "interrupted"]),
  startedAt: startedAt ?? null,
});

const LIVE_STEPS: ReadonlySet<string> = new Set([
  "paused",
  "running",
  "suspended",
]);

const traceOf = (
  run: Run,
  workflow: WorkflowCheckpoint | undefined
): RunRecord["metadata"] => {
  if (workflow === undefined || run.state.kind !== "cancelled") {
    return run.checkpoint === undefined ? {} : { workflow: run.checkpoint };
  }
  const steps = Object.fromEntries(
    Object.entries(workflow.steps).map(([key, step]) => [
      key,
      LIVE_STEPS.has(step.status) ? { ...step, status: "aborted" } : step,
    ])
  );
  return { workflow: { ...workflow, steps } };
};

const runRecordOf = (job: Job, run: Run): RunRecord => {
  const checkpoint = WorkflowCheckpointSchema.safeParse(run.checkpoint);
  const workflow = checkpoint.success ? checkpoint.data : undefined;
  const { tags = {}, triggerId } = job.links;
  return {
    definition: { name: job.handler.name },
    error: errorOf(run.state),
    extensions: triggerId === undefined ? {} : { triggerId },
    id: run.id,
    input: job.input,
    metadata: traceOf(run, workflow),
    output: run.state.kind === "complete" ? run.state.output : null,
    queueId: run.pool,
    snapshot: {
      ...(workflow?.tree ?? {
        cursor: null,
        name: job.handler.name,
        steps: [],
      }),
      input: job.input,
    },
    status: runStatusOf(run.state),
    step: job.handler.name,
    tags: { ...tags },
    timestamps: timestampsOf(job, run),
  };
};

type LifecycleType =
  | "run.queued"
  | "run.started"
  | "run.suspended"
  | "run.resumed"
  | "run.completed"
  | "run.failed"
  | "run.cancelled";

type RunField =
  | "error"
  | "extensions"
  | "metadata"
  | "output"
  | "tags"
  | "timestamps";

interface RunEventFields {
  readonly at: string;
  readonly id: string;
  readonly queueId: string;
  readonly runId: string;
}

export type RunEvent =
  | (RunEventFields & { readonly type: LifecycleType })
  | (RunEventFields & {
      readonly changed: readonly RunField[];
      readonly type: "run.updated";
    })
  | (RunEventFields & {
      readonly definition?: z.infer<typeof DefinitionReferenceSchema>;
      readonly links?: z.infer<typeof RunLinksSchema>;
      readonly step: string;
      readonly tags: Readonly<Record<string, string>>;
      readonly type: "run.removed";
    });

const ENTERED: Partial<Record<QueueEvent["type"], LifecycleType>> = {
  "run.cancelled": "run.cancelled",
  "run.completed": "run.completed",
  "run.failed": "run.failed",
  "run.interrupted": "run.failed",
  "run.queued": "run.queued",
  "run.resumed": "run.resumed",
  "run.started": "run.started",
  "run.suspended": "run.suspended",
};

const changedBy = (run: Run): readonly RunField[] => {
  if (run.state.kind === "complete") {
    return run.state.output === null ? [] : ["output"];
  }
  return run.state.kind === "failed" || run.state.kind === "interrupted"
    ? ["error"]
    : [];
};

export const runEventsOf = (events: readonly QueueEvent[]): RunEvent[] =>
  events.flatMap((event): RunEvent[] => {
    const type = ENTERED[event.type];
    if (type === undefined || !("run" in event)) {
      return [];
    }
    const base = {
      at: new Date(event.at).toISOString(),
      queueId: event.run.pool,
      runId: event.run.id,
    };
    const changed = changedBy(event.run);
    return [
      { ...base, id: event.id, type },
      ...(changed.length === 0
        ? []
        : [
            {
              ...base,
              changed,
              id: `${event.id}:updated`,
              type: "run.updated" as const,
            },
          ]),
    ];
  });

export const isRunId = (id: string): id is RunId => id.startsWith("rn-");

export type RunReads = Pick<
  QueueStoreService,
  "getJob" | "getRun" | "listJobs" | "listRuns"
>;

export const surfaced = (error: unknown): unknown =>
  error instanceof StoreError && error.cause instanceof Error
    ? error.cause
    : error;

export const runStoreEffect = async <A>(
  effect: Effect.Effect<A, unknown>
): Promise<A> => {
  const exit = await Effect.runPromiseExit(effect);
  if (Exit.isSuccess(exit)) {
    return exit.value;
  }
  throw surfaced(Cause.squash(exit.cause));
};

export const storeEffect = <A>(
  call: () => Promise<A>
): Effect.Effect<A, StoreError> =>
  Effect.tryPromise({
    catch: (cause) =>
      cause instanceof StoreError ? cause : new StoreError({ cause }),
    try: call,
  });

export const commitEffect = (
  call: () => Promise<void>
): Effect.Effect<void, StoreError | WriteConflictError> =>
  Effect.tryPromise({
    catch: (cause) =>
      cause instanceof StoreError || cause instanceof WriteConflictError
        ? cause
        : new StoreError({ cause }),
    try: call,
  });

export const readRun = (
  store: Pick<RunReads, "getJob" | "getRun">,
  runId: string
): Promise<RunRecord | null> =>
  runStoreEffect(
    Effect.gen(function* () {
      if (!isRunId(runId)) {
        return null;
      }
      const run = yield* store.getRun(runId);
      const job = run && (yield* store.getJob(run.jobId));
      return run && job ? runRecordOf(job, run) : null;
    })
  );

const KINDS: readonly RunState["kind"][] = [
  "queued",
  "running",
  "suspended",
  "complete",
  "failed",
  "cancelled",
  "interrupted",
];

const listed = (
  store: Pick<RunReads, "listRuns">,
  statuses: readonly RunStatus[] | undefined
): Effect.Effect<readonly Run[], StoreError> =>
  statuses === undefined
    ? store.listRuns()
    : Effect.map(
        Effect.forEach(
          KINDS.filter((kind) => statuses.includes(STATUS[kind])),
          (state) => store.listRuns({ state })
        ),
        (runs) => runs.flat()
      );

export const readRuns = (
  store: Pick<RunReads, "listJobs" | "listRuns">,
  statuses?: readonly RunStatus[]
): Promise<RunRecord[]> =>
  runStoreEffect(
    Effect.gen(function* () {
      const runs = yield* listed(store, statuses);
      const jobs = new Map<JobId, Job>(
        (yield* store.listJobs()).map((job) => [job.id, job])
      );
      return runs
        .flatMap((run) => {
          const job = jobs.get(run.jobId);
          return job === undefined ? [] : [runRecordOf(job, run)];
        })
        .sort((a, b) => a.timestamps.createdAt - b.timestamps.createdAt);
    })
  );
