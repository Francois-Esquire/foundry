import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, test } from "vitest";

import type { SuspensionRequest, SuspensionState } from "../channels";
import { contributeQueueConfig } from "../config";
import { DispatchedWorkflow } from "../dispatched-workflow";
import type { WorkflowDomainError } from "../errors";
import {
  DefinitionNotRegisteredError,
  JobAlreadySettledError,
  JobAttemptAlreadyActiveError,
  JobNotFoundError,
  OrchestratorNotStartedError,
  RecoverableDefinitionMissingError,
  RunAlreadySettledError,
  RunNotFoundError,
  RunNotSuspendedError,
  RunReplayGapError,
  SuspensionOccurrenceMismatchError,
} from "../errors";
import type { BaseContext } from "../executable";
import type {
  AppendRunFrameInput,
  ClaimRunEffectInput,
  CreateJobInput,
  CreateJobRunInput,
  CreateRunInput,
  CreateSuspensionInput,
  Extensions,
  ExtensionValue,
  JobCancellation,
  JobQuery,
  JobRunClaim,
  JsonValue,
  OrchestratorStore,
  RecoverableRun,
  RunQuery,
  SettleSuspensionInput,
  SuspensionCancellation,
  SuspensionParking,
  SuspensionQuery,
  SuspensionSettlement,
  SuspensionSettlementOutcome,
  UpdateJobInput,
  UpdateRunInput,
} from "../index";
import {
  ExecutionCoordinator,
  validateOrchestratorStoreSnapshot,
} from "../index";
import type { OrchestratorLogger, RunLifecycleEvent } from "../logger";
import { BaseOrchestratorLogger } from "../logger";
import type { WorkflowTraceFacts } from "../metadata-codec";
import { workflowTraceFactsFromMetadata } from "../metadata-codec";
import type {
  CreateJobOptions,
  DirectRunLinks,
  Factory,
  ObserveRunOptions,
  OrchestratorOptions,
  ResolveSuspensionOptions,
  RunExecutionContext,
  RunObservation,
  RunOptions,
} from "../orchestrator";
import { Orchestrator } from "../orchestrator";
import { Queue } from "../queue";
import type {
  DispatchOptions,
  QueueEvent,
  QueueEventPayload,
  QueueOptions,
} from "../queue-types";
import type { RunJournal } from "../run-journal";
import type {
  DefinitionReference,
  JobLinks,
  JobRecord,
  JobStatus,
  OrchestratorStoreSnapshot,
  PersistedMetadata,
  PersistedWorkflow,
  QueueRecord,
  RunFrame,
  RunFramePayload,
  RunLinks,
  RunRecord,
  SuspensionRecord,
  SuspensionStatus,
} from "../schema";
import {
  JobRecordSchema,
  JsonValueSchema,
  ORCHESTRATOR_STORE_SNAPSHOT_VERSION,
  OrchestratorStoreSnapshotSchema,
  RunFrameSchema,
  RunRecordSchema,
  SuspensionRecordSchema,
} from "../schema";
import type { StepSnapshot, StepStatus, WorkflowSnapshot } from "../snapshot";
import type { StepContext, StepSpec } from "../step";
import { Step } from "../step";
import type {
  AfterFailureStepHook,
  AfterFailureStepHookInput,
  AfterSuccessStepHook,
  AfterSuccessStepHookInput,
  AfterSuspensionStepHook,
  AfterSuspensionStepHookInput,
  BeforeStepHook,
  StepHooks,
} from "../step-hooks";
import { withStepHooks } from "../step-hooks";
import type {
  WorkflowStore,
  WorkflowStorePage,
  WorkflowStoreWrite,
} from "../store/index";
import type { RunStatus } from "../types";
import type { WorkflowResult } from "../workflow";
import { Workflow } from "../workflow";

type PublicTypePins = [
  PersistedMetadata,
  PersistedWorkflow,
  Factory,
  DirectRunLinks,
  ObserveRunOptions,
  RunObservation,
  RunExecutionContext,
  OrchestratorOptions,
  RunOptions,
  ResolveSuspensionOptions,
  CreateJobOptions,
  QueueEvent,
  QueueEventPayload,
  QueueOptions,
  DispatchOptions,
  StepSpec,
  StepContext,
  BeforeStepHook,
  AfterSuccessStepHook,
  AfterSuccessStepHookInput,
  AfterFailureStepHook,
  AfterFailureStepHookInput,
  AfterSuspensionStepHook,
  AfterSuspensionStepHookInput,
  StepHooks,
  WorkflowResult,
  WorkflowSnapshot,
  StepSnapshot,
  StepStatus,
  SuspensionState,
  SuspensionRequest,
  BaseContext,
  RunStatus,
  RunRecord,
  JsonValue,
  DefinitionReference,
  JobStatus,
  JobLinks,
  JobRecord,
  JobCancellation,
  RunLinks,
  SuspensionStatus,
  SuspensionRecord,
  RunFramePayload,
  RunFrame,
  OrchestratorStore,
  OrchestratorStoreSnapshot,
  CreateJobInput,
  CreateJobRunInput,
  UpdateJobInput,
  JobQuery,
  JobRunClaim,
  CreateRunInput,
  ExtensionValue,
  Extensions,
  UpdateRunInput,
  RunQuery,
  CreateSuspensionInput,
  SuspensionQuery,
  SuspensionParking,
  SuspensionCancellation,
  SuspensionSettlementOutcome,
  SettleSuspensionInput,
  SuspensionSettlement,
  AppendRunFrameInput,
  ClaimRunEffectInput,
  QueueRecord,
  RecoverableRun,
  OrchestratorLogger,
  RunLifecycleEvent,
  WorkflowDomainError,
  RunJournal,
  WorkflowTraceFacts,
  WorkflowStore,
  WorkflowStorePage<RunRecord>,
  WorkflowStoreWrite,
];

export type PublicSurfacePins = PublicTypePins;

const packageJsonUrl = new URL("../../package.json", import.meta.url);
const expectedExportKeys = [
  ".",
  "./approval",
  "./authored",
  "./orchestrator",
  "./queue",
  "./step",
  "./definitions",
  "./step-hooks",
  "./workflow",
  "./snapshot",
  "./channels",
  "./config",
  "./types",
  "./executable",
  "./store",
  "./store/memory",
  "./store/sqlite",
  "./store/tables",
  "./schema",
  "./testing/store",
  "./logger",
];

describe("public surface", () => {
  test("value exports remain defined", async () => {
    const [snapshotPublic, channelsPublic, executablePublic] =
      await Promise.all([
        import("../snapshot-public"),
        import("../channels-public"),
        import("../executable-public"),
      ]);
    expect(Orchestrator).toBeDefined();
    expect(typeof Orchestrator.prototype.cancelRun).toBe("function");
    expect(typeof Orchestrator.prototype.cancelJob).toBe("function");
    expect(Queue).toBeDefined();
    expect(DispatchedWorkflow).toBeDefined();
    expect(Step).toBeDefined();
    expect(typeof withStepHooks).toBe("function");
    expect(Workflow).toBeDefined();
    expect(typeof contributeQueueConfig).toBe("function");
    expect(BaseOrchestratorLogger).toBeDefined();
    expect(JsonValueSchema).toBeDefined();
    expect(JobRecordSchema).toBeDefined();
    expect(SuspensionRecordSchema).toBeDefined();
    expect(RunFrameSchema).toBeDefined();
    expect(RunRecordSchema).toBeDefined();
    expect(ORCHESTRATOR_STORE_SNAPSHOT_VERSION).toBe(1);
    expect(OrchestratorStoreSnapshotSchema).toBeDefined();
    expect(typeof validateOrchestratorStoreSnapshot).toBe("function");
    expect(typeof ExecutionCoordinator).toBe("function");
    expect(typeof workflowTraceFactsFromMetadata).toBe("function");
    expect(OrchestratorNotStartedError).toBeDefined();
    expect(JobNotFoundError).toBeDefined();
    expect(JobAlreadySettledError).toBeDefined();
    expect(RunNotFoundError).toBeDefined();
    expect(RunAlreadySettledError).toBeDefined();
    expect(DefinitionNotRegisteredError).toBeDefined();
    expect(JobAttemptAlreadyActiveError).toBeDefined();
    expect(RecoverableDefinitionMissingError).toBeDefined();
    expect(RunNotSuspendedError).toBeDefined();
    expect(RunReplayGapError).toBeDefined();
    expect(SuspensionOccurrenceMismatchError).toBeDefined();
    expect(snapshotPublic).not.toHaveProperty("Snapshot");
    expect(channelsPublic).not.toHaveProperty("Channels");
    expect(executablePublic).not.toHaveProperty("Executable");
    expect(Workflow).not.toHaveProperty("make");
    expect(Workflow).not.toHaveProperty("fromStep");
  });

  test("the schema entry defines every record and its embedded values", async () => {
    const schemaPublic = await import("../schema");
    const recordSchemas = [
      "ChannelEventSchema",
      "DefinitionReferenceSchema",
      "ErrorShapeSchema",
      "JobLinksSchema",
      "JobRecordSchema",
      "JobStatusSchema",
      "JsonValueSchema",
      "OrchestratorStoreSnapshotSchema",
      "PersistedMetadataSchema",
      "PersistedWorkflowSchema",
      "QueueRecordSchema",
      "QueueStatusSchema",
      "RunEventSchema",
      "RunEventTypeSchema",
      "RunFramePayloadSchema",
      "RunFrameSchema",
      "RunLinksSchema",
      "RunRecordSchema",
      "RunRecordShapeSchema",
      "RunStatusSchema",
      "SnapshotStateSchema",
      "StepSnapshotSchema",
      "StepStatusSchema",
      "SuspensionRecordSchema",
      "SuspensionStateSchema",
      "SuspensionStatusSchema",
      "WorkflowSnapshotSchema",
      "WorkflowStepNodeSchema",
    ] as const;

    for (const name of recordSchemas) {
      expect(typeof schemaPublic[name].safeParse).toBe("function");
    }
    expect(schemaPublic.ORCHESTRATOR_STORE_SNAPSHOT_VERSION).toBe(1);
    expect(schemaPublic.RUN_EVENT_TYPES).toStrictEqual(
      schemaPublic.RunEventTypeSchema.options
    );
  });

  test("exports map remains curated and targets existing files", () => {
    const pkg = JSON.parse(readFileSync(packageJsonUrl, "utf8")) as {
      exports: Record<string, { import: string }>;
    };

    expect(Object.keys(pkg.exports).sort()).toEqual(expectedExportKeys.sort());
    for (const entry of Object.values(pkg.exports)) {
      expect(existsSync(new URL(entry.import, packageJsonUrl))).toBe(true);
    }
  });
});

const SOURCE = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PACKAGE_ROOT = resolve(SOURCE, "..");

/** A name a store implementation would export under. */
const STORE_NAME = /Store$/;

/** The only entries that may load Drizzle. */
const SQLITE_ENTRIES = ["./store/sqlite", "./store/tables"];

/** Specifiers that would load the SQLite stack, and each half of it. */
const SQLITE_STACK = /^(drizzle-orm|@libsql\/)/;
const DRIZZLE = /^drizzle-orm/;
const LIBSQL = /^@libsql\//;

/** A static or dynamic import or re-export, and whether it loads at runtime. */
const STATIC_IMPORT =
  /^\s*(?:import|export)\s+(type\s+)?(?:[^;]*?\s+from\s+)?["']([^"']+)["']/gm;
const DYNAMIC_IMPORT = /\bimport\(\s*["']([^"']+)["']\s*\)/g;

interface Manifest {
  readonly exports: Readonly<Record<string, { readonly import: string }>>;
  readonly peerDependencies?: Readonly<Record<string, string>>;
  readonly peerDependenciesMeta?: Readonly<
    Record<string, { readonly optional?: boolean }>
  >;
}

const manifest = JSON.parse(
  readFileSync(join(PACKAGE_ROOT, "package.json"), "utf8")
) as Manifest;

/** Each import in `file`: its specifier, and whether it is only a type. */
function importsOf(file: string) {
  const text = readFileSync(file, "utf8");
  return [
    ...[...text.matchAll(STATIC_IMPORT)].map((match) => ({
      specifier: match[2] ?? "",
      typeOnly: match[1] !== undefined,
    })),
    ...[...text.matchAll(DYNAMIC_IMPORT)].map((match) => ({
      specifier: match[1] ?? "",
      typeOnly: false,
    })),
  ];
}

/** The file a relative specifier names, from `file`. */
function resolved(file: string, specifier: string): string {
  const base = resolve(dirname(file), specifier);
  for (const candidate of [base, `${base}.ts`, join(base, "index.ts")]) {
    if (existsSync(candidate) && statSync(candidate).isFile()) {
      return candidate;
    }
  }
  throw new Error(
    `${relative(SOURCE, file)} imports ${specifier}, which is no file`
  );
}

/** Every file `entries` load at runtime, following relative imports. */
function runtimeGraph(entries: readonly string[]): string[] {
  const seen = new Set<string>();
  const pending = [...entries];
  while (pending.length > 0) {
    const file = pending.pop() as string;
    if (seen.has(file)) {
      continue;
    }
    seen.add(file);
    for (const { specifier, typeOnly } of importsOf(file)) {
      if (!typeOnly && specifier.startsWith(".")) {
        pending.push(resolved(file, specifier));
      }
    }
  }
  return [...seen];
}

/** Every non-test source file. */
function sourceFiles(): string[] {
  return readdirSync(SOURCE, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".ts"))
    .map((entry) => join(entry.parentPath, entry.name))
    .filter((file) => !relative(SOURCE, file).startsWith("test/"));
}

describe("@foundry/workflows store paths", () => {
  test("map the store, both stores, the tables and the suite to their files", () => {
    expect(
      Object.fromEntries(
        [
          ".",
          "./store",
          "./store/memory",
          "./store/sqlite",
          "./store/tables",
          "./testing/store",
        ].map((path) => [path, manifest.exports[path]?.import])
      )
    ).toEqual({
      ".": "./src/index.ts",
      "./store": "./src/store/index.ts",
      "./store/memory": "./src/store/memory.ts",
      "./store/sqlite": "./src/store/sqlite.ts",
      "./store/tables": "./src/store/tables.ts",
      "./testing/store": "./src/testing/store.ts",
    });
  });

  test("export each store from its own path, and none from the main entry", async () => {
    expect(Object.keys(await import("../store/sqlite"))).toEqual([
      "SqliteWorkflowStore",
    ]);
    expect(Object.keys(await import("../store/tables")).sort()).toEqual([
      "workflowJobs",
      "workflowPositions",
      "workflowQueues",
      "workflowRunFrames",
      "workflowRuns",
      "workflowSuspensions",
    ]);
    expect(Object.keys(await import("../store/index"))).toEqual([]);
    expect(Object.keys(await import("../store/memory"))).toEqual([
      "MemoryWorkflowStore",
    ]);
    expect(Object.keys(await import("../testing/store"))).toEqual([
      "describeWorkflowStore",
    ]);
    const main = Object.keys(await import("../index"));
    expect(main).toContain("ExecutionCoordinator");
    expect(main.filter((name) => STORE_NAME.test(name))).toEqual([]);
  }, 30_000);

  test("keep Drizzle an optional peer", () => {
    expect(manifest.peerDependencies?.["drizzle-orm"]).toBeDefined();
    expect(manifest.peerDependenciesMeta?.["drizzle-orm"]?.optional).toBe(true);
  });

  test("import Drizzle only in the SQLite store and its tables, and libSQL nowhere", () => {
    const importers = (pattern: RegExp) =>
      sourceFiles()
        .filter((file) =>
          importsOf(file).some(({ specifier }) => pattern.test(specifier))
        )
        .map((file) => relative(SOURCE, file))
        .sort();

    expect(importers(DRIZZLE)).toEqual(["store/sqlite.ts", "store/tables.ts"]);
    expect(importers(LIBSQL)).toEqual([]);
  });

  test("load no Drizzle from any other entry, the memory store included, through any import chain", () => {
    const entries = Object.entries(manifest.exports)
      .filter(([path]) => !SQLITE_ENTRIES.includes(path))
      .map(([, target]) => join(PACKAGE_ROOT, target.import));
    const graph = runtimeGraph(entries);
    expect(graph).toContain(join(SOURCE, "store/memory.ts"));
    expect(graph).toContain(join(SOURCE, "execution-coordinator.ts"));

    const loading = graph.flatMap((file) =>
      importsOf(file)
        .filter(
          ({ specifier, typeOnly }) => !typeOnly && SQLITE_STACK.test(specifier)
        )
        .map(({ specifier }) => `${relative(SOURCE, file)} loads ${specifier}`)
    );
    expect(loading).toEqual([]);
    expect(graph).not.toContain(join(SOURCE, "store/sqlite.ts"));
    expect(graph).not.toContain(join(SOURCE, "store/tables.ts"));
  });
});
