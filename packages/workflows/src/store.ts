/** Compatibility public surface for existing Orchestrator consumers. */

export type { OrchestratorStore } from "./execution-coordinator";
// biome-ignore lint/performance/noBarrelFile: This is the exported @foundry/workflows/store compatibility API.
export {
  AbstractOrchestratorStore,
  ExecutionCoordinator,
} from "./execution-coordinator";
export type {
  DefinitionReference,
  JobLinks,
  JobRecord,
  JobStatus,
  JsonValue,
  RunFrame,
  RunFramePayload,
  RunLinks,
  RunRecord,
  RunTimestamps,
  SuspensionRecord,
  SuspensionStatus,
} from "./execution-records";
export {
  decodeJobRecord,
  decodeRunRecord,
  decodeSuspensionRecord,
} from "./execution-records";
export type {
  CreateJobInput,
  CreateJobRunInput,
  CreateRunInput,
  CreateSuspensionInput,
  DirectRunLinks,
  EnsureQueueInput,
  ExecutionRepository,
  JobCancellation,
  JobCancellationTransaction,
  JobQuery,
  JobRunClaim,
  JobRunClaimOutcome,
  JobRunClaimTransaction,
  PageQuery,
  QueueRecord,
  RecoverableRun,
  RunQuery,
  SettleSuspensionInput,
  SuspensionCancellation,
  SuspensionCancellationTransaction,
  SuspensionParking,
  SuspensionParkingTransaction,
  SuspensionQuery,
  SuspensionSettlement,
  SuspensionSettlementOutcome,
  SuspensionSettlementTransaction,
  UpdateJobInput,
  UpdateQueueInput,
  UpdateRunInput,
} from "./execution-repository";
export type { Extensions, ExtensionValue } from "./extensions";
export {
  createExtensions,
  extensionsFromUnknown,
  mergeExtensions,
} from "./extensions";
export { InMemoryOrchestratorStore } from "./in-memory-execution-persistence";
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
export {
  DefinitionReferenceSchema,
  JobLinksSchema,
  JobRecordSchema,
  JobStatusSchema,
  JsonValueSchema,
  ORCHESTRATOR_STORE_SNAPSHOT_VERSION,
  OrchestratorStoreSnapshotSchema,
  RunFramePayloadSchema,
  RunFrameSchema,
  RunLinksSchema,
  RunRecordSchema,
  RunStatusSchema,
  SuspensionRecordSchema,
  SuspensionStatusSchema,
} from "./schema";
export type { OrchestratorStoreSnapshot } from "./store-snapshot";
export { validateOrchestratorStoreSnapshot } from "./store-snapshot";
