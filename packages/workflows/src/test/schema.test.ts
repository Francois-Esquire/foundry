import { describe, expect, test } from "vitest";

import {
  ChannelEventSchema,
  StepSnapshotSchema,
  SuspensionStateSchema,
  WorkflowSnapshotSchema,
  WorkflowStepNodeSchema,
} from "../schema";

const lifecycle = { at: "2026-05-02T00:00:00.000Z", attempt: 1, name: "step" };

describe("record decoding rules", () => {
  test("a workflow snapshot's input is optional", () => {
    const snapshot = { cursor: null, name: "flow", steps: [] };

    expect(WorkflowSnapshotSchema.parse(snapshot)).toHaveProperty(
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

  test("unconstrained numbers admit NaN and infinities", () => {
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
  });

  test("decoded arrays stay mutable; records that rebuild drop unknown keys", () => {
    const decoded = WorkflowSnapshotSchema.parse({
      cursor: null,
      extra: 1,
      name: "flow",
      steps: [],
    });

    expect(Object.isFrozen(decoded.steps)).toBe(false);
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

describe("rebuilt dictionaries keep every own string key", () => {
  test("an entry named __proto__ stays an own entry, not a prototype", () => {
    const entry = { nested: true };
    const state = SuspensionStateSchema.parse({
      meta: withProtoEntry({ kept: 1 }, entry),
      name: "approve",
      reason: "needs review",
      suspendedAt: "2026-05-02T00:00:00.000Z",
    });

    expect(hasOwnEntry(state.meta, "__proto__", entry)).toBe(true);
  });
});

describe("record shapes stay visible", () => {
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
