import type { ExecutionRepository } from "./execution-repository";
import { createInMemoryPersistenceAdapters } from "./in-memory-execution-persistence";
import type { RunJournal } from "./run-journal";
import type { OrchestratorStoreSnapshot } from "./store-snapshot";

export {
  decodeJobRecord,
  decodeRunRecord,
  decodeSuspensionRecord,
} from "./execution-records";
export type { ExecutionRepository } from "./execution-repository";
export type { WorkflowTraceFacts } from "./metadata-codec";
export { workflowTraceFactsFromMetadata } from "./metadata-codec";
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
  isPostTerminalRunEvidence,
  isRunEffectClaim,
  runEffectClaimPayload,
} from "./run-journal";

/** One host-provided persistence capability with internal domain seams. */
export interface ExecutionPersistence {
  /** Defer through the outermost transaction; rollback drops the callback. */
  readonly afterCommit?: <T>(operation: () => T) => T | undefined;
  readonly journal: RunJournal;
  readonly repository: ExecutionRepository;
  /** Use the supplied handles inside the callback; host participants join its commit. */
  readonly transaction?: <T>(
    operation: (persistence: ExecutionPersistence) => Promise<T>
  ) => Promise<T>;
}

export interface InMemoryExecutionPersistence extends ExecutionPersistence {
  snapshot(): OrchestratorStoreSnapshot;
}

/** Zero-configuration reference persistence used by local runtimes and tests. */
export function createInMemoryExecutionPersistence(
  options: { readonly snapshot?: unknown } = {}
): InMemoryExecutionPersistence {
  return createInMemoryPersistenceAdapters(options);
}
