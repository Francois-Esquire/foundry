import { describe, expect, test } from "vitest";
import { z } from "zod";
import { taskChangeSchema } from "../operations";
import {
  readyQuerySchema,
  taskChangeResultSchema,
  taskNodeSchema,
  taskPageSchema,
  taskQuerySchema,
  taskRelationsSchema,
  taskSchema,
} from "../schemas";
import { Tasks } from "../tasks";

const clock = () => new Date("2026-10-29T00:00:00.000Z");

async function backlog() {
  const tasks = new Tasks({ clock });
  const result = await tasks.change({
    operations: [
      {
        input: { description: "the epic", tags: ["api", "api"], title: "Epic" },
        key: "epic",
        kind: "task.create",
      },
      {
        input: { metadata: { size: "m" }, title: "Build" },
        key: "build",
        kind: "task.create",
        parent: { key: "epic" },
      },
      {
        input: { status: "completed", title: "Design" },
        key: "design",
        kind: "task.create",
        parent: { key: "epic" },
      },
      {
        dependsOn: { key: "design" },
        kind: "dependency.add",
        task: { key: "build" },
      },
    ],
  });
  return { result, tasks };
}

describe("schemas", () => {
  test("every record a read or change returns parses strictly, unchanged", async () => {
    const { result, tasks } = await backlog();
    expect(result.tasks.map((task) => task.tags)).toEqual([["api"], [], []]);
    expect(taskChangeResultSchema.parse(result)).toEqual(result);
    for (const task of result.tasks) {
      expect(taskSchema.parse(task)).toEqual(task);
    }
    const [epic, build] = result.tasks;
    const tree = await tasks.get(epic?.id ?? "", { depth: 2 });
    expect(taskNodeSchema.parse(tree)).toEqual(tree);
    const list = await tasks.list({ depth: 1, limit: 1 });
    expect(taskPageSchema.parse(list)).toEqual(list);
    const ready = await tasks.ready();
    expect(taskPageSchema.parse(ready)).toEqual(ready);
    const relations = await tasks.dependencies(build?.id ?? "");
    expect(taskRelationsSchema.parse(relations)).toEqual(relations);
    const tagged = await tasks.list({ tags: { all: ["api"] } });
    expect(taskPageSchema.parse(tagged).items.map((task) => task.id)).toEqual([
      epic?.id,
    ]);
  });

  test("a record without tags is refused: Tasks always returns them", async () => {
    const { result } = await backlog();
    const { tags: _, ...untagged } = result.tasks[0] ?? {};
    expect(taskSchema.safeParse(untagged).success).toBe(false);
  });

  test("a record with a field the schema does not know is refused", async () => {
    const { result } = await backlog();
    expect(
      taskSchema.safeParse({ ...result.tasks[0], extra: true }).success
    ).toBe(false);
  });

  test("queries take exactly what the package applies", () => {
    expect(
      taskQuerySchema.parse({ depth: 1, limit: 5, parentId: null })
    ).toEqual({ depth: 1, limit: 5, parentId: null });
    expect(taskQuerySchema.parse({ parentId: "tk-1", status: "open" })).toEqual(
      { parentId: "tk-1", status: "open" }
    );
    expect(
      taskQuerySchema.parse({ tags: { all: ["a"], any: ["b", ""] } })
    ).toEqual({ tags: { all: ["a"], any: ["b", ""] } });
    expect(readyQuerySchema.parse({ tags: { any: ["b"] } })).toEqual({
      tags: { any: ["b"] },
    });
    for (const query of [
      { labels: ["x"] },
      { tags: ["x"] },
      { tags: { none: ["x"] } },
      { tags: { all: [1] } },
      { status: "done" },
      { limit: 0 },
      { limit: 1.5 },
      { cursor: -1 },
      { depth: -1 },
      { parentId: "" },
    ]) {
      expect(taskQuerySchema.safeParse(query).success, String(query)).toBe(
        false
      );
    }
    expect(readyQuerySchema.safeParse({ status: "open" }).success).toBe(false);
    expect(readyQuerySchema.safeParse({ tags: { none: [] } }).success).toBe(
      false
    );
    expect(readyQuerySchema.parse({ cursor: 2, limit: 3 })).toEqual({
      cursor: 2,
      limit: 3,
    });
  });

  test("every schema converts to JSON Schema for tool descriptions", () => {
    for (const schema of [
      taskQuerySchema,
      readyQuerySchema,
      taskChangeSchema,
    ]) {
      expect(() => z.toJSONSchema(schema, { io: "input" })).not.toThrow();
    }
    for (const schema of [
      taskPageSchema,
      taskRelationsSchema,
      taskChangeResultSchema,
    ]) {
      expect(() => z.toJSONSchema(schema, { io: "output" })).not.toThrow();
    }
  });
});
