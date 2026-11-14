import { describe, expect, test } from "vitest";

import {
  ChannelEventSchema,
  RunFrameSchema,
  RunRecordSchema,
  StepSnapshotSchema,
  SuspensionRecordSchema,
  SuspensionStateSchema,
  WorkflowSnapshotSchema,
} from "../schema";

const run = {
  error: null,
  extensions: {},
  id: "rn-1",
  input: null,
  metadata: {},
  output: null,
  queueId: "main",
  snapshot: { cursor: null, input: null, name: "flow", steps: [] },
  status: "running",
  step: "flow",
  tags: {},
  timestamps: {
    completedAt: null,
    createdAt: 1,
    failedAt: null,
    startedAt: null,
  },
};

const suspension = {
  id: "su-1",
  kind: "approval",
  name: "approve",
  occurrence: 0,
  reason: "needs review",
  request: null,
  resolution: null,
  revision: 0,
  runId: "rn-1",
  status: "pending",
  stepPath: ["draft"],
  timestamps: { cancelledAt: null, createdAt: 1, resolvedAt: null },
};

const lifecycle = { at: "2026-05-02T00:00:00.000Z", attempt: 1, name: "step" };

class RunLike {
  constructor() {
    Object.assign(this, run);
  }
}

describe("record decoding rules", () => {
  test("a Run admits only plain data objects", () => {
    expect(RunRecordSchema.safeParse(run).success).toBe(true);
    expect(RunRecordSchema.safeParse(new RunLike()).success).toBe(false);
    expect(
      RunRecordSchema.safeParse({ ...run, error: new Error("boom") }).success
    ).toBe(false);
    expect(
      RunRecordSchema.safeParse({
        ...run,
        timestamps: Object.assign(new RunLike(), run.timestamps),
      }).success
    ).toBe(false);
  });

  test("a Run's snapshot carries a present, JSON-safe input", () => {
    const { input: _input, ...withoutInput } = run.snapshot;

    expect(
      RunRecordSchema.safeParse({ ...run, snapshot: withoutInput }).success
    ).toBe(false);
    expect(WorkflowSnapshotSchema.parse(withoutInput)).toHaveProperty(
      "input",
      undefined
    );
  });

  test("a required unknown value survives JSON dropping undefined", () => {
    const completed = JSON.parse(
      JSON.stringify({
        _tag: "step.complete",
        ...lifecycle,
        path: ["step"],
        value: undefined,
      })
    );

    expect(ChannelEventSchema.parse(completed)).toEqual({
      _tag: "step.complete",
      ...lifecycle,
      path: ["step"],
      value: undefined,
    });
  });

  test("unconstrained numbers admit NaN and infinities; finite ones do not", () => {
    expect(
      ChannelEventSchema.safeParse({
        _tag: "step.progress",
        ...lifecycle,
        path: [],
        value: Number.NaN,
      }).success
    ).toBe(true);
    expect(
      StepSnapshotSchema.safeParse({
        attempt: Number.POSITIVE_INFINITY,
        name: "step",
        namespace: "",
        status: "running",
      }).success
    ).toBe(true);
    expect(
      RunFrameSchema.safeParse({
        at: 1,
        cursor: 0,
        payload: { kind: "progress", value: Number.POSITIVE_INFINITY },
        runId: "rn-1",
      }).success
    ).toBe(false);
  });

  test("string-keyed records admit any non-array object and keep string keys", () => {
    class Meta {
      readonly approver = "editor";
    }
    const symbolKeyed = { approver: "editor", [Symbol("hidden")]: true };
    const state = (meta: unknown) => ({
      meta,
      name: "approve",
      reason: "needs review",
      suspendedAt: "2026-05-02T00:00:00.000Z",
    });

    expect(SuspensionStateSchema.parse(state(new Meta())).meta).toEqual({
      approver: "editor",
    });
    expect(SuspensionStateSchema.parse(state(symbolKeyed)).meta).toEqual({
      approver: "editor",
    });
    expect(SuspensionStateSchema.safeParse(state(["editor"])).success).toBe(
      false
    );
    expect(
      RunRecordSchema.safeParse({ ...run, metadata: new Meta() }).success
    ).toBe(false);
  });

  test("decoded arrays stay mutable and unknown keys are dropped", () => {
    const decoded = SuspensionRecordSchema.parse({ ...suspension, extra: 1 });

    expect(Object.isFrozen(decoded.stepPath)).toBe(false);
    expect(decoded).not.toHaveProperty("extra");
    expect(RunRecordSchema.parse({ ...run, extra: 1 })).not.toHaveProperty(
      "extra"
    );
  });
});
