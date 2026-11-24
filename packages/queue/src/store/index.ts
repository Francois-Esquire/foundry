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
  Wait,
  WaitFilter,
  WaitId,
} from "../domain";

export interface QueueWrite {
  readonly events?: readonly QueueEvent[];
  readonly jobs?: readonly Job[];
  readonly pools?: readonly ConcurrencyPool[];
  readonly runs?: readonly Run[];
  readonly waits?: readonly Wait[];
}

export interface QueueStoreService {
  readonly commit: (write: QueueWrite) => Effect.Effect<void, StoreError>;
  readonly getJob: (id: JobId) => Effect.Effect<Job | undefined, StoreError>;
  readonly getRun: (id: RunId) => Effect.Effect<Run | undefined, StoreError>;
  readonly getWait: (id: WaitId) => Effect.Effect<Wait | undefined, StoreError>;
  readonly listJobs: (
    filter?: JobFilter
  ) => Effect.Effect<readonly Job[], StoreError>;
  readonly listPools: Effect.Effect<readonly ConcurrencyPool[], StoreError>;
  readonly listRuns: (
    filter?: RunFilter
  ) => Effect.Effect<readonly Run[], StoreError>;
  readonly listWaits: (
    filter?: WaitFilter
  ) => Effect.Effect<readonly Wait[], StoreError>;
}

export class QueueStore extends Context.Tag("@foundry/queue/QueueStore")<
  QueueStore,
  QueueStoreService
>() {}
