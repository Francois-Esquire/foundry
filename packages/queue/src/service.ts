import type { JsonValue } from "@foundry/lib/json";
import type { ProcessIdentity } from "@foundry/lib/process-identity";
import type { Effect, Scope, Stream } from "effect";
import type {
  ConcurrencyPool,
  ErrorShape,
  ExecutionPolicy,
  HandlerAlreadyRegisteredError,
  HandlerRef,
  InvalidPoolLimitError,
  Job,
  JobFilter,
  JobId,
  Links,
  PoolName,
  PoolStats,
  QueueError,
  QueueEvent,
  QueueOwner,
  RecoverySummary,
  Run,
  RunFilter,
  RunId,
  RunOutcome,
  StoreError,
  Suspension,
  SuspensionFilter,
  SuspensionId,
} from "./domain";

export interface RunContext {
  readonly checkpoint: JsonValue | undefined;
  readonly job: Job;
  readonly resolutions: ReadonlyMap<string, JsonValue>;
  readonly run: Run;
  readonly saveCheckpoint: (
    value: JsonValue
  ) => Effect.Effect<void, QueueError>;
  readonly signal: AbortSignal;
}

export type RunHandler = (
  context: RunContext
) => Effect.Effect<RunOutcome, ErrorShape>;

export interface SubmitJobInput {
  readonly delayMs?: number;
  readonly handler: HandlerRef;
  readonly input?: JsonValue;
  readonly links?: Links;
  readonly policy?: ExecutionPolicy;
  readonly pool?: PoolName;
  readonly runId?: RunId;
}

export interface QueueOptions {
  readonly defaultLimit?: number;
  readonly identity?: ProcessIdentity;
  readonly instanceId?: string;
  readonly isOwnerGone?: (owner: ProcessIdentity) => boolean;
  readonly leaseHeartbeatMs?: number;
  readonly leaseTtlMs?: number;
  readonly pools?: readonly ConcurrencyPool[];
  readonly syncIntervalMs?: number;
}

export interface ResolveSuspensionOptions {
  readonly expectedRevision?: number;
}

export interface RecoverOptions {
  readonly isOwnerGone?: (owner: ProcessIdentity) => boolean;
}

export interface QueueService {
  readonly abandon: (
    id: RunId,
    error: ErrorShape
  ) => Effect.Effect<Run, QueueError>;
  readonly awaitJob: (id: JobId) => Effect.Effect<Job, QueueError>;
  readonly cancel: (
    id: JobId | RunId,
    reason?: string
  ) => Effect.Effect<void, QueueError>;
  readonly cancelSuspension: (
    suspensionId: SuspensionId,
    reason?: string
  ) => Effect.Effect<Suspension, QueueError>;
  readonly configurePool: (
    pool: ConcurrencyPool
  ) => Effect.Effect<void, InvalidPoolLimitError | QueueError>;
  readonly drain: (graceMs?: number) => Effect.Effect<void, QueueError>;
  readonly drainUntilIdle: (
    graceMs?: number
  ) => Effect.Effect<void, QueueError>;
  readonly getJob: (id: JobId) => Effect.Effect<Job | undefined, StoreError>;
  readonly getRun: (id: RunId) => Effect.Effect<Run | undefined, StoreError>;
  readonly getSuspension: (
    id: SuspensionId
  ) => Effect.Effect<Suspension | undefined, StoreError>;
  readonly listJobs: (
    filter?: JobFilter
  ) => Effect.Effect<readonly Job[], StoreError>;
  readonly listRuns: (
    filter?: RunFilter
  ) => Effect.Effect<readonly Run[], StoreError>;
  readonly listSuspensions: (
    filter?: SuspensionFilter
  ) => Effect.Effect<readonly Suspension[], StoreError>;
  readonly pause: Effect.Effect<void>;
  readonly pools: Effect.Effect<readonly PoolStats[]>;
  readonly recover: (
    options?: RecoverOptions
  ) => Effect.Effect<RecoverySummary, QueueError>;
  readonly register: (
    name: string,
    handler: RunHandler
  ) => Effect.Effect<void, HandlerAlreadyRegisteredError>;
  readonly removeJob: (id: JobId) => Effect.Effect<void, QueueError>;
  readonly resolveSuspension: (
    suspensionId: SuspensionId,
    value: JsonValue,
    options?: ResolveSuspensionOptions
  ) => Effect.Effect<Suspension, QueueError>;
  readonly resume: Effect.Effect<void>;
  readonly retire: (
    successor?: QueueOwner
  ) => Effect.Effect<readonly RunId[], QueueError>;
  readonly submit: (input: SubmitJobInput) => Effect.Effect<Job, QueueError>;
  readonly subscribe: Effect.Effect<
    Stream.Stream<QueueEvent>,
    never,
    Scope.Scope
  >;
}
