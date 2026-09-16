import { existsSync, readFileSync } from "node:fs";

import { describe, expect, test } from "vitest";

import type { SuspensionRequest, SuspensionState } from "../channels";
import * as ChannelsPublic from "../channels-public";
import { contributeQueueConfig } from "../config";
import type { BaseContext } from "../executable";
import * as ExecutablePublic from "../executable-public";
import type { OrchestratorLogger, RunLifecycleEvent } from "../logger";
import { BaseOrchestratorLogger } from "../logger";
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
import type {
  ExecutionPersistence,
  ExecutionRepository,
  InMemoryExecutionPersistence,
  RunJournal,
  WorkflowTraceFacts,
} from "../persistence";
import {
  createInMemoryExecutionPersistence,
  workflowTraceFactsFromMetadata,
} from "../persistence";
import type {
  DispatchOptions,
  QueueEvent,
  QueueEventPayload,
  QueueOptions,
} from "../queue";
import { DispatchedWorkflow, Queue } from "../queue";
import type { StepSnapshot, StepStatus, WorkflowSnapshot } from "../snapshot";
import * as SnapshotPublic from "../snapshot-public";
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
  AppendRunFrameInput,
  ClaimRunEffectInput,
  CreateJobInput,
  CreateJobRunInput,
  CreateRunInput,
  CreateSuspensionInput,
  DefinitionReference,
  Extensions,
  ExtensionValue,
  JobCancellation,
  JobCancellationTransaction,
  JobLinks,
  JobQuery,
  JobRecord,
  JobRunClaim,
  JobRunClaimTransaction,
  JobStatus,
  JsonValue,
  OrchestratorStore,
  OrchestratorStoreSnapshot,
  QueueRecord,
  RecoverableRun,
  RunFrame,
  RunFramePayload,
  RunLinks,
  RunQuery,
  RunRecord,
  SettleSuspensionInput,
  SuspensionCancellation,
  SuspensionParking,
  SuspensionQuery,
  SuspensionRecord,
  SuspensionSettlement,
  SuspensionSettlementOutcome,
  SuspensionStatus,
  UpdateJobInput,
  UpdateRunInput,
} from "../store";
import {
  JobRecordSchema,
  JsonValueSchema,
  ORCHESTRATOR_STORE_SNAPSHOT_VERSION,
  OrchestratorStoreSnapshotSchema,
  RunFrameSchema,
  RunRecordSchema,
  SuspensionRecordSchema,
  validateOrchestratorStoreSnapshot,
} from "../store";
import type { RunStatus, WorkflowDomainError } from "../types";
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
} from "../types";
import type { WorkflowResult } from "../workflow";
import { Workflow } from "../workflow";

type PublicTypePins = [
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
  JobCancellationTransaction,
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
  JobRunClaimTransaction,
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
  ExecutionPersistence,
  InMemoryExecutionPersistence,
  ExecutionRepository,
  RunJournal,
  WorkflowTraceFacts,
];

export type PublicSurfacePins = PublicTypePins;

const packageJsonUrl = new URL("../../package.json", import.meta.url);
const expectedExportKeys = [
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
  "./persistence",
  "./logger",
  "./testing",
];

describe("public surface", () => {
  test("value exports remain defined", () => {
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
    expect(typeof createInMemoryExecutionPersistence).toBe("function");
    expect(typeof workflowTraceFactsFromMetadata).toBe("function");
    expect(OrchestratorNotStartedError).toBeDefined();
    expect(JobNotFoundError).toBeDefined();
    expect(JobAlreadySettledError).toBeDefined();
    expect(RunNotFoundError).toBeDefined();
    expect(RunAlreadySettledError).toBeDefined();
    expect(DefinitionNotRegisteredError).toBeDefined();
    expect(JobAttemptAlreadyActiveError).toBeDefined();
    expect(RecoverableDefinitionMissingError).toBeDefined();
    expect(RunNotFoundError).toBeDefined();
    expect(RunNotSuspendedError).toBeDefined();
    expect(RunReplayGapError).toBeDefined();
    expect(SuspensionOccurrenceMismatchError).toBeDefined();
    expect(SnapshotPublic).not.toHaveProperty("Snapshot");
    expect(ChannelsPublic).not.toHaveProperty("Channels");
    expect(ExecutablePublic).not.toHaveProperty("Executable");
    expect(Workflow).not.toHaveProperty("make");
    expect(Workflow).not.toHaveProperty("fromStep");
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
