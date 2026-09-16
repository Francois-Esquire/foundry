import type { OrchestratorStore } from "./execution-coordinator";
import { ExecutionCoordinator } from "./execution-coordinator";
import type { ExecutionPersistence } from "./persistence";

/** Internal bridge for the legacy Orchestrator Store interface. */
export function orchestratorStoreFromPersistence(
  persistence: ExecutionPersistence
): OrchestratorStore {
  return new ExecutionCoordinator(persistence.repository, persistence.journal);
}
