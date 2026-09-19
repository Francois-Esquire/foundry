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
  DefinitionReferenceSchema,
  decodeJobRecord,
  decodeRunRecord,
  decodeSuspensionRecord,
  isJsonValue,
  JobLinksSchema,
  JobRecordSchema,
  JobStatusSchema,
  JsonValueSchema,
  RunFramePayloadSchema,
  RunFrameSchema,
  RunLinksSchema,
  RunRecordSchema,
  RunStatusSchema,
  SuspensionRecordSchema,
  SuspensionStatusSchema,
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
export type { OrchestratorStoreSnapshot } from "./store-snapshot";
export {
  ORCHESTRATOR_STORE_SNAPSHOT_VERSION,
  OrchestratorStoreSnapshotSchema,
  validateOrchestratorStoreSnapshot,
} from "./store-snapshot";
