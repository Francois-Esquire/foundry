import { describe, expect, test } from "vitest";
import { taskChangeSchema } from "../operations";

describe("taskChangeSchema", () => {
  test("accepts every operation kind with batch keys and tokens", () => {
    const change = {
      operations: [
        {
          input: { metadata: { n: 1, tags: ["x"] }, title: "a" },
          key: "a",
          kind: "task.create",
        },
        {
          input: { status: "active", title: "b" },
          key: "b",
          kind: "task.create",
          parent: { key: "a" },
        },
        { dependsOn: { key: "a" }, kind: "dependency.add", task: { key: "b" } },
        {
          dependsOn: { id: "tk-1" },
          kind: "dependency.remove",
          task: { id: "tk-2" },
        },
        {
          expectedUpdatedAt: "2026-10-29T00:00:00.000Z",
          kind: "task.update",
          patch: { description: null, metadata: { gone: null, n: 2 } },
          task: { id: "tk-1" },
        },
        { kind: "task.set_status", status: "completed", task: { id: "tk-1" } },
        {
          kind: "task.set_status",
          requireReady: true,
          status: "active",
          task: { id: "tk-1" },
        },
        { kind: "task.move", parent: null, task: { id: "tk-1" } },
      ],
    };
    expect(taskChangeSchema.parse(change)).toEqual(change);
  });

  test("rejects unknown fields, bad refs, non-JSON metadata, and empty batches", () => {
    const rejected = [
      { operations: [] },
      { operations: [{ input: { title: "" }, key: "a", kind: "task.create" }] },
      {
        operations: [
          { extra: 1, input: { title: "a" }, key: "a", kind: "task.create" },
        ],
      },
      {
        operations: [
          { kind: "task.set_status", status: "done", task: { id: "x" } },
        ],
      },
      {
        operations: [
          {
            kind: "task.move",
            parent: { id: "a", key: "b" },
            task: { id: "x" },
          },
        ],
      },
      {
        operations: [
          {
            expectedUpdatedAt: "yesterday",
            kind: "task.update",
            patch: {},
            task: { id: "x" },
          },
        ],
      },
      {
        operations: [
          {
            input: { metadata: { f: () => 1 }, title: "a" },
            key: "a",
            kind: "task.create",
          },
        ],
      },
    ];
    for (const change of rejected) {
      expect(taskChangeSchema.safeParse(change).success).toBe(false);
    }
  });

  test("keeps a __proto__ metadata key at any depth", () => {
    // A quoted `__proto__` in an object literal sets the prototype; parsed
    // JSON defines the key.
    const metadata = JSON.parse('{"__proto__":null,"x":{"__proto__":1}}');
    const parsed = taskChangeSchema.parse({
      operations: [
        { kind: "task.update", patch: { metadata }, task: { id: "t" } },
      ],
    });
    const [operation] = parsed.operations;
    const patch = operation?.kind === "task.update" ? operation.patch : {};
    expect(JSON.stringify(patch.metadata)).toBe(
      '{"__proto__":null,"x":{"__proto__":1}}'
    );

    const hidden = JSON.parse('{"x":{"__proto__":1}}');
    Object.defineProperty(hidden.x, "__proto__", {
      enumerable: true,
      value: () => 1,
    });
    for (const bad of [[], "text", hidden]) {
      const change = {
        operations: [
          { kind: "task.update", patch: { metadata: bad }, task: { id: "t" } },
        ],
      };
      expect(taskChangeSchema.safeParse(change).success).toBe(false);
    }
  });
});
