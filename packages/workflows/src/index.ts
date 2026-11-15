/**
 * The execution records' domain API: `ExecutionCoordinator`, which holds
 * every rule of Jobs, Runs, Suspensions, Queues and the Run journal over a
 * `WorkflowStore`, the commands and queries it takes, and the decoders and
 * checks of persisted data. No store lives here: the store seam is
 * `./store`, the stores are `./store/memory` and `./store/sqlite`, and the
 * record schemas and types are `./schema`.
 */

export type {
  CreateJobInput,
  CreateJobRunInput,
  CreateRunInput,
  CreateSuspensionInput,
  DirectRunLinks,
  EnsureQueueInput,
  JobCancellation,
  JobQuery,
  JobRunClaim,
  PageQuery,
  RecoverableRun,
  RunQuery,
  SettleSuspensionInput,
  SuspensionCancellation,
  SuspensionParking,
  SuspensionQuery,
  SuspensionSettlement,
  SuspensionSettlementOutcome,
  UpdateJobInput,
  UpdateQueueInput,
  UpdateRunInput,
} from "./execution-commands";
export type {
  ExecutionCoordinatorOptions,
  OrchestratorStore,
} from "./execution-coordinator";
// biome-ignore lint/performance/noBarrelFile: This is the package's main entry.
export { ExecutionCoordinator } from "./execution-coordinator";
export {
  decodeJobRecord,
  decodeRunRecord,
  decodeSuspensionRecord,
} from "./execution-records";
export type { Extensions, ExtensionValue } from "./extensions";
export {
  createExtensions,
  extensionsFromUnknown,
  mergeExtensions,
} from "./extensions";
export type { JsonValue } from "./json-value";
export { isJsonValue } from "./json-value";
export type {
  AppendRunFrameInput,
  ClaimRunEffectInput,
  FrameRun,
  RunFramePageQuery,
  RunJournal,
} from "./run-journal";
export {
  decodeRunFrame,
  decodeRunFrameSequence,
  decodeRunFrames,
} from "./run-journal";
export type { RunFact, RunFactType } from "./schema";
export { validateOrchestratorStoreSnapshot } from "./store-snapshot";
