import { Schema } from "effect";
import { describe, expect, test } from "vitest";

import {
  DefinitionNotRegisteredError,
  JobAlreadySettledError,
  JobAttemptAlreadyActiveError,
  OrchestratorNotStartedError,
  RecordAlreadyExistsError,
  RecordInUseError,
  RunNotFoundError,
  RunNotSuspendedError,
  RunReplayGapError,
  StaleSuspensionRevisionError,
  SuspensionAlreadySettledError,
  SuspensionOccurrenceMismatchError,
  UnsupportedStoreSnapshotVersionError,
  WorkflowDomainError,
} from "../errors";
import {
  DefinitionReferenceSchema,
  JobRecordSchema,
  JsonValueSchema,
  RunFrameSchema,
  RunRecordSchema,
  SuspensionRecordSchema,
} from "../execution-records";

const decode = <A, I>(schema: Schema.Schema<A, I>) =>
  Schema.decodeUnknownSync(schema);

const representativeJob = {
  definition: { name: "documents.generate", version: "1" },
  id: "jb-123",
  input: { prompt: "Draft a summary", selection: null },
  links: {
    invocationId: "invocation-123",
    principalId: "user-123",
    sessionId: "session-123",
    subjectId: "document-123",
    taskId: "task-123",
  },
  status: "active",
  timestamps: {
    cancelledAt: null,
    completedAt: null,
    createdAt: 1,
    failedAt: null,
  },
} as const;

const representativeSuspension = {
  id: "su-123",
  kind: "approval",
  name: "approve-document-change",
  occurrence: 0,
  reason: "The editor must accept the proposed change",
  request: { changeId: "change-123" },
  resolution: null,
  revision: 0,
  runId: "rn-123",
  status: "pending",
  stepPath: ["draft", "apply"],
  timestamps: {
    cancelledAt: null,
    createdAt: 2,
    resolvedAt: null,
  },
} as const;

const representativeRun = {
  definition: { name: "documents.generate", version: "1" },
  error: null,
  extensions: { "studio.subject": "document-123" },
  id: "rn-123",
  input: { prompt: "Draft a summary" },
  links: { sessionId: "session-123", subjectId: "document-123" },
  metadata: { workflow: null },
  output: null,
  queueId: "main",
  snapshot: {
    cursor: null,
    input: { prompt: "Draft a summary" },
    name: "documents.generate",
    steps: [],
  },
  status: "running",
  step: "documents.generate",
  tags: { surface: "documents" },
  timestamps: {
    completedAt: null,
    createdAt: 1,
    failedAt: null,
    startedAt: 2,
  },
} as const;

describe("execution record schemas", () => {
  test("decode representative JSON-safe records", () => {
    expect(
      decode(DefinitionReferenceSchema)(representativeJob.definition)
    ).toEqual(representativeJob.definition);
    expect(decode(JobRecordSchema)(representativeJob)).toEqual(
      representativeJob
    );
    expect(decode(SuspensionRecordSchema)(representativeSuspension)).toEqual(
      representativeSuspension
    );
    expect(decode(RunRecordSchema)(representativeRun)).toEqual(
      representativeRun
    );
    expect(
      decode(RunFrameSchema)({
        at: 3,
        cursor: 0,
        payload: { kind: "suspension", value: representativeSuspension },
        runId: "rn-123",
      })
    ).toEqual({
      at: 3,
      cursor: 0,
      payload: { kind: "suspension", value: representativeSuspension },
      runId: "rn-123",
    });
  });

  test("round-trips representative records through JSON", () => {
    const records = [
      decode(JobRecordSchema)(representativeJob),
      decode(SuspensionRecordSchema)(representativeSuspension),
      decode(RunRecordSchema)(representativeRun),
      decode(RunFrameSchema)({
        at: 4,
        cursor: 1,
        payload: { kind: "output", value: { delta: "hello" } },
        runId: "rn-123",
      }),
    ];

    expect(JSON.parse(JSON.stringify(records))).toEqual(records);
  });

  test("rejects invalid identities, statuses, and revisions", () => {
    expect(() =>
      decode(JobRecordSchema)({ ...representativeJob, id: "job-123" })
    ).toThrow();
    expect(() =>
      decode(JobRecordSchema)({ ...representativeJob, status: "running" })
    ).toThrow();
    expect(() =>
      decode(SuspensionRecordSchema)({
        ...representativeSuspension,
        runId: "run-123",
      })
    ).toThrow();
    expect(() =>
      decode(RunRecordSchema)({ ...representativeRun, id: "run-123" })
    ).toThrow();
    expect(() =>
      decode(RunRecordSchema)({
        ...representativeRun,
        metadata: { callback: () => undefined },
      })
    ).toThrow();
    expect(() =>
      decode(RunFrameSchema)({
        at: 3,
        cursor: 0,
        payload: { kind: "suspension", value: representativeSuspension },
        runId: "rn-other",
      })
    ).toThrow();
    expect(() =>
      decode(SuspensionRecordSchema)({
        ...representativeSuspension,
        revision: -1,
      })
    ).toThrow();
  });

  test("rejects non-JSON values and live handles", () => {
    const decodeJson = decode(JsonValueSchema);
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    const sparse = new Array(2) as unknown[];
    sparse[1] = "value";
    const compensatedSparse = new Array(2) as unknown[] & {
      extra?: unknown;
    };
    compensatedSparse[1] = "value";
    compensatedSparse.extra = "not-an-index";
    const customPrototype = { own: "value" };
    Object.setPrototypeOf(customPrototype, { inherited: true });
    let accessorReads = 0;
    const accessor = {};
    Object.defineProperty(accessor, "value", {
      enumerable: true,
      get: () => {
        accessorReads += 1;
        return "value";
      },
    });

    expect(() => decodeJson({ callback: () => undefined })).toThrow();
    expect(() => decodeJson({ effect: Promise.resolve() })).toThrow();
    expect(() => decodeJson({ map: new Map([["key", "value"]]) })).toThrow();
    expect(() => decodeJson({ number: Number.POSITIVE_INFINITY })).toThrow();
    expect(() => decodeJson(cyclic)).toThrow();
    expect(() => decodeJson(sparse)).toThrow();
    expect(() => decodeJson(compensatedSparse)).toThrow();
    expect(() => decodeJson(customPrototype)).toThrow();
    expect(() => decodeJson(accessor)).toThrow();
    expect(accessorReads).toBe(0);
  });
});

describe("workflow domain errors", () => {
  test.each([
    [new OrchestratorNotStartedError(), "ORCHESTRATOR_NOT_STARTED"],
    [
      new DefinitionNotRegisteredError("documents.generate"),
      "DEFINITION_NOT_REGISTERED",
    ],
    [new RunNotFoundError("rn-123"), "RUN_NOT_FOUND"],
    [new RunNotSuspendedError("rn-123"), "RUN_NOT_SUSPENDED"],
    [new RunReplayGapError("rn-123", 3, 4, 8), "RUN_REPLAY_GAP"],
    [new JobAlreadySettledError("jb-123"), "JOB_ALREADY_SETTLED"],
    [
      new JobAttemptAlreadyActiveError("jb-123", "rn-123"),
      "JOB_ATTEMPT_ALREADY_ACTIVE",
    ],
    [new RecordAlreadyExistsError("job", "jb-123"), "RECORD_ALREADY_EXISTS"],
    [new RecordInUseError("run", "rn-123"), "RECORD_IN_USE"],
    [
      new StaleSuspensionRevisionError("su-123", 1, 2),
      "STALE_SUSPENSION_REVISION",
    ],
    [new SuspensionAlreadySettledError("su-123"), "SUSPENSION_ALREADY_SETTLED"],
    [
      new SuspensionOccurrenceMismatchError("su-123"),
      "SUSPENSION_OCCURRENCE_MISMATCH",
    ],
    [
      new UnsupportedStoreSnapshotVersionError(2),
      "UNSUPPORTED_STORE_SNAPSHOT_VERSION",
    ],
  ])("exposes a stable name and code for %s", (error, code) => {
    expect(error).toBeInstanceOf(Error);
    expect(error).toBeInstanceOf(WorkflowDomainError);
    expect(error.name).not.toBe("Error");
    expect(error.code).toBe(code);
  });
});
