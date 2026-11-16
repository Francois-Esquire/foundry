import { describe, expect, test } from "vitest";

import { decodeRunRecord } from "../index";
import {
  ChannelEventSchema,
  ORCHESTRATOR_STORE_SNAPSHOT_VERSION,
  RunFrameSchema,
  RunRecordSchema,
  RunRecordShapeSchema,
  StepSnapshotSchema,
  SuspensionRecordSchema,
  SuspensionStateSchema,
  WorkflowSnapshotSchema,
  WorkflowStepNodeSchema,
} from "../schema";
import { validateOrchestratorStoreSnapshot } from "../store-snapshot";
import { restoredStore } from "./helpers/store";

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

  test("decoded arrays stay mutable; records that rebuild drop unknown keys", () => {
    const decoded = SuspensionRecordSchema.parse({ ...suspension, extra: 1 });

    expect(Object.isFrozen(decoded.stepPath)).toBe(false);
    expect(decoded).not.toHaveProperty("extra");
  });
});

function withProtoEntry(
  entries: Record<string, unknown>,
  protoValue: unknown
): Record<string, unknown> {
  const dictionary: Record<string, unknown> = { ...entries };
  Object.defineProperty(dictionary, "__proto__", {
    configurable: true,
    enumerable: true,
    value: protoValue,
    writable: true,
  });
  return dictionary;
}

function hasOwnEntry(value: unknown, key: string, expected: unknown): boolean {
  return (
    typeof value === "object" &&
    value !== null &&
    Object.getPrototypeOf(value) === Object.prototype &&
    Object.hasOwn(value, key) &&
    JSON.stringify(Object.getOwnPropertyDescriptor(value, key)?.value) ===
      JSON.stringify(expected)
  );
}

const queue = {
  createdAt: 1,
  extensions: {},
  id: "main",
  lastError: null,
  name: "main",
  status: "active",
};

function restore(runs: unknown[], queues: unknown[] = [queue]) {
  return validateOrchestratorStoreSnapshot({
    frames: [],
    jobs: [],
    queues,
    runs,
    suspensions: [],
    version: ORCHESTRATOR_STORE_SNAPSHOT_VERSION,
  });
}

describe("a Run is admitted unchanged", () => {
  test("decoding returns the same record, undeclared fields included", () => {
    const extended = {
      ...run,
      extra: 123,
      snapshot: { ...run.snapshot, custom: 456 },
    };

    expect(decodeRunRecord(extended)).toBe(extended);

    const [restored] = restore([extended]).runs;
    expect(restored).toMatchObject({ extra: 123, snapshot: { custom: 456 } });
  });

  test("snapshot restore keeps dictionary entries named __proto__", () => {
    const entry = { nested: true };
    const [restored] = restore([
      {
        ...run,
        extensions: withProtoEntry({ "host.kept": 1 }, entry),
        metadata: withProtoEntry({ kept: 1 }, entry),
        tags: withProtoEntry({ kept: "yes" }, "tag"),
      },
    ]).runs;

    expect(hasOwnEntry(restored?.metadata, "__proto__", entry)).toBe(true);
    expect(hasOwnEntry(restored?.extensions, "__proto__", entry)).toBe(true);
    expect(hasOwnEntry(restored?.tags, "__proto__", "tag")).toBe(true);
    expect(restored?.metadata).toHaveProperty("kept", 1);
  });

  test("an exported store snapshot restores with its Runs intact", async () => {
    const entry = { nested: true };
    const stored = {
      ...run,
      extra: 123,
      metadata: withProtoEntry({ kept: 1 }, entry),
      snapshot: { ...run.snapshot, custom: 456 },
      tags: withProtoEntry({ kept: "yes" }, "tag"),
    };
    const exported = await (await restoredStore(restore([stored]))).snapshot();
    const [restored] = (
      await (
        await restoredStore(JSON.parse(JSON.stringify(exported)))
      ).snapshot()
    ).runs;

    expect(restored).toMatchObject({ extra: 123, snapshot: { custom: 456 } });
    expect(hasOwnEntry(restored?.metadata, "__proto__", entry)).toBe(true);
    expect(hasOwnEntry(restored?.tags, "__proto__", "tag")).toBe(true);
  });

  test("Run containers are JSON-checked as a whole before their entries", () => {
    const withGetter = {};
    Object.defineProperty(withGetter, "computed", {
      enumerable: true,
      get: () => "value",
    });
    const withHidden = { visible: 1 };
    Object.defineProperty(withHidden, "hidden", { value: 1 });

    for (const container of [withGetter, withHidden]) {
      expect(
        RunRecordSchema.safeParse({ ...run, metadata: container }).success
      ).toBe(false);
      expect(
        RunRecordSchema.safeParse({ ...run, extensions: container }).success
      ).toBe(false);
    }
  });

  test("an explicit undefined definition or links is still admitted", () => {
    expect(
      RunRecordSchema.safeParse({
        ...run,
        definition: undefined,
        links: undefined,
      }).success
    ).toBe(true);
  });
});

describe("rebuilt dictionaries keep every own string key", () => {
  test("an entry named __proto__ stays an own entry, not a prototype", () => {
    const entry = { nested: true };
    const state = SuspensionStateSchema.parse({
      meta: withProtoEntry({ kept: 1 }, entry),
      name: "approve",
      reason: "needs review",
      suspendedAt: "2026-05-02T00:00:00.000Z",
    });
    const [restoredQueue] = restore(
      [],
      [{ ...queue, extensions: withProtoEntry({ "host.kept": 1 }, entry) }]
    ).queues;

    expect(hasOwnEntry(state.meta, "__proto__", entry)).toBe(true);
    expect(hasOwnEntry(restoredQueue?.extensions, "__proto__", entry)).toBe(
      true
    );
  });
});

describe("record shapes stay visible for table derivation", () => {
  test("the Run decoder is built from its exported shape", () => {
    expect(Object.keys(RunRecordShapeSchema.shape).sort()).toEqual([
      "definition",
      "error",
      "extensions",
      "id",
      "input",
      "links",
      "metadata",
      "output",
      "queueId",
      "snapshot",
      "status",
      "step",
      "tags",
      "timestamps",
    ]);
    expect(RunRecordShapeSchema.safeParse(run).success).toBe(true);
  });

  test("readonly arrays and the recursive node expose their schemas", () => {
    expect(WorkflowSnapshotSchema.shape.steps.element).toBe(
      WorkflowStepNodeSchema
    );
    expect(WorkflowStepNodeSchema.shape.children.unwrap().element).toBe(
      WorkflowStepNodeSchema
    );
    expect(Object.keys(WorkflowStepNodeSchema.shape).sort()).toEqual([
      "children",
      "index",
      "key",
      "name",
    ]);
  });
});

describe("decoded key order", () => {
  test("a step node decodes as children, index, key, name", () => {
    const node = WorkflowStepNodeSchema.parse(
      JSON.parse(
        '{"name":"root","key":"root","index":0,"children":[{"name":"leaf","key":"root.leaf","index":0}]}'
      )
    );

    expect(Object.keys(node)).toEqual(["children", "index", "key", "name"]);
    expect(Object.keys(node.children?.[0] ?? {})).toEqual([
      "index",
      "key",
      "name",
    ]);
    expect(
      JSON.stringify(
        WorkflowSnapshotSchema.parse({
          cursor: null,
          input: null,
          name: "flow",
          steps: [node],
        }).steps
      )
    ).toBe(
      '[{"children":[{"index":0,"key":"root.leaf","name":"leaf"}],"index":0,"key":"root","name":"root"}]'
    );
  });
});
