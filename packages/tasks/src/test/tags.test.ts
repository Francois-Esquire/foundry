import { describe, expect, test } from "vitest";
import { taskChangeSchema } from "../operations";
import { MemoryTaskStore } from "../store";
import { Tasks } from "../tasks";
import type { Task } from "../types";
import { taskId } from "../types";

const clock = () => new Date("2026-10-29T00:00:00.000Z");

describe("task tags", () => {
  test("create stores exact strings once, in first order; omission is none", async () => {
    const tasks = new Tasks({ clock });
    const tagged = await tasks.create({
      tags: ["review", "", "Review", "review", "api"],
      title: "Tagged",
    });
    const plain = await tasks.create({ title: "Plain" });

    expect(tagged.tags).toEqual(["review", "", "Review", "api"]);
    expect(plain.tags).toEqual([]);
    expect((await tasks.get(tagged.id))?.tags).toEqual(tagged.tags);
  });

  test("update replaces tags, [] clears them, and omission keeps them", async () => {
    const tasks = new Tasks({ clock });
    const task = await tasks.create({ tags: ["a", "b"], title: "T" });

    const kept = await tasks.update(task.id, { title: "Renamed" });
    expect(kept.tags).toEqual(["a", "b"]);
    const replaced = await tasks.update(task.id, { tags: ["c", "c", "a"] });
    expect(replaced.tags).toEqual(["c", "a"]);
    const cleared = await tasks.update(task.id, { tags: [] });
    expect(cleared.tags).toEqual([]);
  });

  test("the batch language carries tags through the same schema", async () => {
    const change = {
      operations: [
        {
          input: { tags: ["x", "y"], title: "a" },
          key: "a",
          kind: "task.create",
        },
        { kind: "task.update", patch: { tags: [] }, task: { key: "a" } },
      ],
    };
    expect(taskChangeSchema.parse(change)).toEqual(change);
    for (const tags of [[42], "x", [null]]) {
      expect(
        taskChangeSchema.safeParse({
          operations: [
            { input: { tags, title: "a" }, key: "a", kind: "task.create" },
          ],
        }).success
      ).toBe(false);
      expect(
        taskChangeSchema.safeParse({
          operations: [
            { kind: "task.update", patch: { tags }, task: { id: "tk-1" } },
          ],
        }).success
      ).toBe(false);
    }

    const tasks = new Tasks({ clock });
    const result = await tasks.change(taskChangeSchema.parse(change));
    expect(result.tasks[0]?.tags).toEqual([]);
  });

  test("list and ready filter by all and any, before paging", async () => {
    const tasks = new Tasks({ clock });
    const both = await tasks.create({ tags: ["review", "api"], title: "1" });
    const urgent = await tasks.create({
      tags: ["review", "urgent"],
      title: "2",
    });
    const api = await tasks.create({ tags: ["api"], title: "3" });
    const none = await tasks.create({ title: "4" });
    await tasks.create(
      { tags: ["review", "api"], title: "blocked" },
      { dependsOn: [{ id: none.id }] }
    );

    const ids = (items: readonly Task[]) => items.map((task) => task.id);
    const listed = async (query: Parameters<Tasks["list"]>[0]) =>
      ids((await tasks.list(query)).items);
    const ready = async (query: Parameters<Tasks["ready"]>[0]) =>
      ids((await tasks.ready(query)).items);

    expect(await listed({ tags: { all: ["review"] } })).toHaveLength(3);
    expect(
      await listed({ tags: { all: ["review"], any: ["api", "urgent"] } })
    ).toHaveLength(3);
    expect(
      await ready({ tags: { all: ["review"], any: ["api", "urgent"] } })
    ).toEqual([both.id, urgent.id]);
    expect(await ready({ tags: { any: ["api"] } })).toEqual([both.id, api.id]);
    expect(await ready({ tags: { all: ["review", "api"] } })).toEqual([
      both.id,
    ]);
    // Empty lists impose nothing; tags are exact strings.
    expect(await ready({ tags: { all: [], any: [] } })).toHaveLength(4);
    expect(await ready({ tags: { any: ["Review"] } })).toEqual([]);
    // Paging applies to the filtered tasks.
    const page = await tasks.ready({ limit: 1, tags: { any: ["api"] } });
    expect(ids(page.items)).toEqual([both.id]);
    expect(page.nextCursor).toBe(1);
  });

  test("records stored before tags read, filter, and change as untagged", async () => {
    const store = new MemoryTaskStore();
    const at = "2026-10-28T00:00:00.000Z";
    const legacy = {
      createdAt: at,
      description: null,
      id: taskId("tk-legacy"),
      metadata: {},
      parentId: null,
      settledAt: null,
      status: "open",
      title: "Old",
      updatedAt: at,
    } as unknown as Task;
    await store.commit({ putTasks: [legacy] });
    const tasks = new Tasks({ clock, store });

    expect((await tasks.get("tk-legacy"))?.tags).toEqual([]);
    expect((await tasks.list()).items[0]?.tags).toEqual([]);
    expect((await tasks.ready({ tags: { any: ["x"] } })).items).toEqual([]);
    const updated = await tasks.update("tk-legacy", { title: "Kept" });
    expect(updated.tags).toEqual([]);
  });
});
