import { describe, expect, test } from "vitest";
import packageJson from "../../package.json" with { type: "json" };
import type { Factory, RunExecutionContext, Runnable } from "../definitions";
import type { JsonValue } from "../index";
import {
  isJsonValue,
  restoreWorkflow,
  Step,
  Workflow,
  WorkflowCheckpointSchema,
  workflowHandler,
} from "../index";
import type {
  WorkflowCheckpoint,
  WorkflowExecution,
  WorkflowHandlerOptions,
  WorkflowRunFactory,
} from "../queue-handler";
import type { SuspensionRequest, SuspensionState } from "../slices/channels";
import type { BaseContext } from "../slices/executable";
import type {
  StepSnapshot,
  StepStatus,
  WorkflowSnapshot,
} from "../slices/snapshot";
import type { StepContext, StepSpec } from "../step";
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
import type { RunStatus } from "../types";
import type { WorkflowResult } from "../workflow";

type PublicTypePins = [
  Factory,
  Runnable,
  RunExecutionContext,
  WorkflowCheckpoint,
  WorkflowExecution,
  WorkflowHandlerOptions,
  WorkflowRunFactory,
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
  JsonValue,
];

export type PublicSurfacePins = PublicTypePins;

const expectedExportKeys = [
  ".",
  "./approval",
  "./channels",
  "./definitions",
  "./executable",
  "./queue-handler",
  "./snapshot",
  "./step",
  "./step-hooks",
  "./types",
  "./workflow",
];

describe("public surface", () => {
  test("value exports remain defined", async () => {
    const [snapshotPublic, channelsPublic, executablePublic] =
      await Promise.all([
        import("../snapshot"),
        import("../channels"),
        import("../executable"),
      ]);
    expect(Step).toBeDefined();
    expect(Workflow).toBeDefined();
    expect(typeof withStepHooks).toBe("function");
    expect(typeof workflowHandler).toBe("function");
    expect(typeof restoreWorkflow).toBe("function");
    expect(typeof WorkflowCheckpointSchema.safeParse).toBe("function");
    expect(isJsonValue({ ok: true })).toBe(true);
    expect(snapshotPublic).not.toHaveProperty("Snapshot");
    expect(channelsPublic).not.toHaveProperty("Channels");
    expect(executablePublic).not.toHaveProperty("Executable");
    expect(Workflow).not.toHaveProperty("make");
    expect(Workflow).not.toHaveProperty("fromStep");
  });

  test("the schema entry defines the kernel's records and their embedded values", async () => {
    const schemaPublic = await import("../schema");
    const recordSchemas = [
      "ChannelEventSchema",
      "ErrorShapeSchema",
      "JsonValueSchema",
      "SnapshotStateSchema",
      "StepSnapshotSchema",
      "StepStatusSchema",
      "SuspensionStateSchema",
      "WorkflowSnapshotSchema",
      "WorkflowStepNodeSchema",
      "WorkflowTelemetrySchema",
    ] as const;

    for (const name of recordSchemas) {
      expect(typeof schemaPublic[name].safeParse).toBe("function");
    }
  });

  test("exports map remains curated", () => {
    expect(Object.keys(packageJson.exports).sort()).toEqual(
      expectedExportKeys.sort()
    );
  });
});
