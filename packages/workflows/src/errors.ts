/** Base class for typed errors at the workflows public seam. */
export abstract class WorkflowDomainError extends Error {
  abstract readonly code: string;
}

export class OrchestratorNotStartedError extends WorkflowDomainError {
  readonly code = "ORCHESTRATOR_NOT_STARTED";

  constructor() {
    super("Orchestrator has not started");
    this.name = "OrchestratorNotStartedError";
  }
}

export class DefinitionNotRegisteredError extends WorkflowDomainError {
  readonly code = "DEFINITION_NOT_REGISTERED";
  readonly definition: string;

  constructor(definition: string) {
    super(`Definition is not registered: ${definition}`);
    this.definition = definition;
    this.name = "DefinitionNotRegisteredError";
  }
}

export class RecoverableDefinitionMissingError extends WorkflowDomainError {
  readonly code = "RECOVERABLE_DEFINITION_MISSING";
  readonly runId: string;
  readonly definition: string;

  constructor(runId: string, definition: string) {
    super(`Run ${runId} cannot recover without definition ${definition}`);
    this.runId = runId;
    this.definition = definition;
    this.name = "RecoverableDefinitionMissingError";
  }
}

export class RunReplayGapError extends WorkflowDomainError {
  readonly code = "RUN_REPLAY_GAP";
  readonly runId: string;
  readonly requestedAfter: number;
  readonly earliestAvailable: number;
  readonly latestAvailable: number;

  constructor(
    runId: string,
    requestedAfter: number,
    earliestAvailable: number,
    latestAvailable = earliestAvailable
  ) {
    super(
      `Run ${runId} cannot replay after cursor ${requestedAfter}; available cursors are ${earliestAvailable} through ${latestAvailable}`
    );
    this.runId = runId;
    this.requestedAfter = requestedAfter;
    this.earliestAvailable = earliestAvailable;
    this.latestAvailable = latestAvailable;
    this.name = "RunReplayGapError";
  }
}

export class ExecutionConflictRetriesExhaustedError extends WorkflowDomainError {
  readonly code = "EXECUTION_CONFLICT_RETRIES_EXHAUSTED";
  readonly operation: string;
  readonly attempts: number;

  constructor(operation: string, attempts: number) {
    super(
      `Execution operation ${operation} exhausted ${attempts} optimistic commit attempts`
    );
    this.operation = operation;
    this.attempts = attempts;
    this.name = "ExecutionConflictRetriesExhaustedError";
  }
}

export class InvalidRunFrameSequenceError extends WorkflowDomainError {
  readonly code = "INVALID_RUN_FRAME_SEQUENCE";
  readonly runId: string;

  constructor(runId: string, message: string) {
    super(`Run ${runId} frame sequence is invalid: ${message}`);
    this.runId = runId;
    this.name = "InvalidRunFrameSequenceError";
  }
}

abstract class RecordError extends WorkflowDomainError {
  readonly recordId: string;

  constructor(recordId: string, message: string) {
    super(message);
    this.recordId = recordId;
  }
}

export class JobNotFoundError extends RecordError {
  readonly code = "JOB_NOT_FOUND";

  constructor(jobId: string) {
    super(jobId, `Job not found: ${jobId}`);
    this.name = "JobNotFoundError";
  }
}

export class JobAlreadySettledError extends RecordError {
  readonly code = "JOB_ALREADY_SETTLED";

  constructor(jobId: string) {
    super(jobId, `Job is already settled: ${jobId}`);
    this.name = "JobAlreadySettledError";
  }
}

export class JobAttemptAlreadyActiveError extends RecordError {
  readonly code = "JOB_ATTEMPT_ALREADY_ACTIVE";
  readonly runId: string;

  constructor(jobId: string, runId: string) {
    super(jobId, `Job ${jobId} already has active Run ${runId}`);
    this.runId = runId;
    this.name = "JobAttemptAlreadyActiveError";
  }
}

export class RunNotFoundError extends RecordError {
  readonly code = "RUN_NOT_FOUND";

  constructor(runId: string) {
    super(runId, `Run not found: ${runId}`);
    this.name = "RunNotFoundError";
  }
}

export class RunAlreadySettledError extends RecordError {
  readonly code = "RUN_ALREADY_SETTLED";

  constructor(runId: string) {
    super(runId, `Run is already settled: ${runId}`);
    this.name = "RunAlreadySettledError";
  }
}

export class SuspensionNotFoundError extends RecordError {
  readonly code = "SUSPENSION_NOT_FOUND";

  constructor(suspensionId: string) {
    super(suspensionId, `Suspension not found: ${suspensionId}`);
    this.name = "SuspensionNotFoundError";
  }
}

export class SuspensionAlreadySettledError extends RecordError {
  readonly code = "SUSPENSION_ALREADY_SETTLED";

  constructor(suspensionId: string) {
    super(suspensionId, `Suspension is already settled: ${suspensionId}`);
    this.name = "SuspensionAlreadySettledError";
  }
}

export class SuspensionOccurrenceMismatchError extends RecordError {
  readonly code = "SUSPENSION_OCCURRENCE_MISMATCH";
  constructor(id: string) {
    super(id, `Suspension occurrence ${id} was rebound with different data`);
    this.name = "SuspensionOccurrenceMismatchError";
  }
}

export class RunNotSuspendedError extends RecordError {
  readonly code = "RUN_NOT_SUSPENDED";
  constructor(id: string) {
    super(id, `Run ${id} is not suspended`);
    this.name = "RunNotSuspendedError";
  }
}

export class RecordAlreadyExistsError extends WorkflowDomainError {
  readonly code = "RECORD_ALREADY_EXISTS";
  readonly recordType: "job" | "run" | "suspension";
  readonly recordId: string;

  constructor(recordType: "job" | "run" | "suspension", recordId: string) {
    super(`${recordType} already exists: ${recordId}`);
    this.recordType = recordType;
    this.recordId = recordId;
    this.name = "RecordAlreadyExistsError";
  }
}

export class RecordInUseError extends WorkflowDomainError {
  readonly code = "RECORD_IN_USE";
  readonly recordType: "job" | "run" | "suspension";
  readonly recordId: string;

  constructor(recordType: "job" | "run" | "suspension", recordId: string) {
    super(`${recordType} is still referenced: ${recordId}`);
    this.recordType = recordType;
    this.recordId = recordId;
    this.name = "RecordInUseError";
  }
}

export class StaleSuspensionRevisionError extends WorkflowDomainError {
  readonly code = "STALE_SUSPENSION_REVISION";
  readonly suspensionId: string;
  readonly expectedRevision: number;
  readonly actualRevision: number;

  constructor(
    suspensionId: string,
    expectedRevision: number,
    actualRevision: number
  ) {
    super(
      `Suspension ${suspensionId} expected revision ${expectedRevision}, actual ${actualRevision}`
    );
    this.suspensionId = suspensionId;
    this.expectedRevision = expectedRevision;
    this.actualRevision = actualRevision;
    this.name = "StaleSuspensionRevisionError";
  }
}

export class InvalidStoreSnapshotError extends WorkflowDomainError {
  readonly code = "INVALID_STORE_SNAPSHOT";

  constructor(message = "Orchestrator store snapshot is invalid") {
    super(message);
    this.name = "InvalidStoreSnapshotError";
  }
}

export class UnsupportedStoreSnapshotVersionError extends WorkflowDomainError {
  readonly code = "UNSUPPORTED_STORE_SNAPSHOT_VERSION";
  readonly version: unknown;

  constructor(version: unknown) {
    super(
      `Unsupported orchestrator store snapshot version: ${String(version)}`
    );
    this.version = version;
    this.name = "UnsupportedStoreSnapshotVersionError";
  }
}

export class InconsistentStoreSnapshotError extends WorkflowDomainError {
  readonly code = "INCONSISTENT_STORE_SNAPSHOT";

  constructor(message: string) {
    super(message);
    this.name = "InconsistentStoreSnapshotError";
  }
}
