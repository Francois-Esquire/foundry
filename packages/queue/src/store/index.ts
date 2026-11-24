import { Context, type Effect } from "effect";
import type {
  ConcurrencyPool,
  Job,
  JobFilter,
  JobId,
  QueueEvent,
  Run,
  RunFilter,
  RunId,
  StoreError,
  Suspension,
  SuspensionFilter,
  SuspensionId,
  WriteConflictError,
} from "../domain";

export interface ExpectedRevision<Id extends string> {
  readonly id: Id;
  readonly revision: number | null;
}

export interface ExpectedRevisions {
  readonly runs?: readonly ExpectedRevision<RunId>[];
  readonly suspensions?: readonly ExpectedRevision<SuspensionId>[];
}

export interface QueueWrite {
  readonly deleteJobs?: readonly JobId[];
  readonly deleteRuns?: readonly RunId[];
  readonly deleteSuspensions?: readonly SuspensionId[];
  readonly events?: readonly QueueEvent[];
  readonly expected?: ExpectedRevisions;
  readonly jobs?: readonly Job[];
  readonly pools?: readonly ConcurrencyPool[];
  readonly runs?: readonly Run[];
  readonly suspensions?: readonly Suspension[];
}

export interface QueueStoreService {
  readonly commit: (
    write: QueueWrite
  ) => Effect.Effect<void, StoreError | WriteConflictError>;
  readonly getJob: (id: JobId) => Effect.Effect<Job | undefined, StoreError>;
  readonly getRun: (id: RunId) => Effect.Effect<Run | undefined, StoreError>;
  readonly getSuspension: (
    id: SuspensionId
  ) => Effect.Effect<Suspension | undefined, StoreError>;
  readonly listJobs: (
    filter?: JobFilter
  ) => Effect.Effect<readonly Job[], StoreError>;
  readonly listPools: Effect.Effect<readonly ConcurrencyPool[], StoreError>;
  readonly listRuns: (
    filter?: RunFilter
  ) => Effect.Effect<readonly Run[], StoreError>;
  readonly listSuspensions: (
    filter?: SuspensionFilter
  ) => Effect.Effect<readonly Suspension[], StoreError>;
}

export class QueueStore extends Context.Tag("@foundry/queue/QueueStore")<
  QueueStore,
  QueueStoreService
>() {}
