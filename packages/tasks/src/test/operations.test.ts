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

  test("refuses metadata that would not survive as plain JSON", () => {
    const update = (metadata: unknown) => ({
      operations: [
        { kind: "task.update", patch: { metadata }, task: { id: "t" } },
      ],
    });
    // A quoted `__proto__` in an object literal sets the prototype; parsed
    // JSON defines the key.
    const proto = JSON.parse('{"__proto__":{"owner":"alice"}}');
    const nested = JSON.parse('{"nested":{"list":[{"__proto__":1}]}}');
    let reads = 0;
    const getter = {
      get late() {
        reads += 1;
        return reads === 1 ? 1 : Number.NaN;
      },
    };
    const refusals: [unknown, string][] = [
      [proto, '"__proto__" is not allowed as a metadata key'],
      [nested, '"__proto__" is not allowed as a metadata key'],
      [getter, "A getter is not JSON data"],
      [{ list: new Array(2) }, "Invalid input"],
      [{ n: Number.NaN }, "Invalid input"],
      [[], "expected record"],
    ];
    for (const [metadata, message] of refusals) {
      const parsed = taskChangeSchema.safeParse(update(metadata));
      expect(parsed.error?.issues[0]?.message).toContain(message);
    }
    expect(
      taskChangeSchema.safeParse(update(nested)).error?.issues[0]?.path
    ).toEqual([
      "operations",
      0,
      "patch",
      "metadata",
      "nested",
      "list",
      0,
      "__proto__",
    ]);
  });

  test("reads metadata into a copy, so the input can change afterwards", () => {
    const metadata = { nested: { list: [1] } };
    const parsed = taskChangeSchema.parse({
      operations: [
        { kind: "task.update", patch: { metadata }, task: { id: "t" } },
      ],
    });
    const [operation] = parsed.operations;
    const copy =
      operation?.kind === "task.update" ? operation.patch.metadata : {};
    metadata.nested.list.push(2);
    expect(copy).toEqual({ nested: { list: [1] } });
  });
});
