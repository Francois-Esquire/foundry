import { describe, expect, it } from "vitest";
import { applyChange } from "../change";
import { TaskError } from "../errors";
import { MAX_OPERATIONS_PER_CHANGE } from "../operations";
import { taskPageSchema } from "../queries";
import type { TaskId } from "../schema";
import type { TaskStore, TaskStoreListQuery } from "../store/index";
import { MemoryTaskStore } from "../store/memory";
import { SqliteTaskStore } from "../store/sqlite";
import { Tasks } from "../tasks";
import { libsqlDatabases } from "./helpers/sqlite";

describe("Tasks cloud-readiness fixes", () => {
  const databases = libsqlDatabases("memory");

  it("avoids snapshot() on hot paths and batches #relationsFor via store.list({ ids })", async () => {
    const inner = new MemoryTaskStore();
    let snapshotCalls = 0;
    const getCalls: TaskId[] = [];
    const listQueries: (TaskStoreListQuery | undefined)[] = [];
    const spyingStore: TaskStore = {
      children: inner.children.bind(inner),
      commit: inner.commit.bind(inner),
      dependenciesOf: inner.dependenciesOf.bind(inner),
      get: (id) => {
        getCalls.push(id);
        return inner.get(id);
      },
      list: (query) => {
        listQueries.push(query);
        return inner.list(query);
      },
      snapshot: () => {
        snapshotCalls += 1;
        return inner.snapshot();
      },
    };

    const setup = new Tasks({ store: inner });
    const pre = await setup.create({ title: "Pre" });
    const center = await setup.create(
      { title: "Center" },
      { dependsOn: [{ id: pre.id }] }
    );
    const dep = await setup.create(
      { title: "Dep" },
      { dependsOn: [{ id: center.id }] }
    );

    const tasks = new Tasks({ store: spyingStore });
    const solo = await tasks.create({ title: "Solo" });
    await tasks.update(center.id, { title: "Center updated" });
    expect(await tasks.availability(pre.id)).toEqual({ kind: "ready" });
    expect((await tasks.ready()).items.map((t) => t.id)).toEqual([
      pre.id,
      solo.id,
    ]);
    await tasks.start(pre.id);
    expect(await tasks.availability(pre.id)).toEqual({ kind: "active" });

    getCalls.length = 0;
    listQueries.length = 0;
    const relations = await tasks.dependencies(center.id);
    expect(relations.dependsOn.map((t) => t.id)).toEqual([pre.id]);
    expect(relations.dependents.map((t) => t.id)).toEqual([dep.id]);
    expect(getCalls).toEqual([center.id]);
    expect(listQueries).toHaveLength(1);
    expect(new Set(listQueries[0]?.ids)).toEqual(new Set([pre.id, dep.id]));

    await tasks.remove(solo.id);
    expect(snapshotCalls).toBe(0);
  });

  it.each(["memory", "sqlite"] as const)(
    "enforces store.list({ ids }) and expectedUpdatedAt CAS (incl. null create-if-absent) in %s store",
    async (kind) => {
      const db = kind === "sqlite" ? await databases.open() : undefined;
      const store =
        db === undefined
          ? new MemoryTaskStore()
          : new SqliteTaskStore({ database: db, scope: `tasks-cas-${kind}` });
      const tasks = new Tasks({ id: () => "dup", store });
      const root = await tasks.create({ title: "Root" });
      expect(root.id).toBe("tk-dup");

      await expect(tasks.create({ title: "Dup" })).rejects.toMatchObject({
        code: "conflict",
      });
      await expect(
        store.commit({
          expectedUpdatedAt: { [root.id]: "2020-01-01T00:00:00.000Z" },
          putTasks: [{ ...root, title: "Stale" }],
        })
      ).rejects.toMatchObject({ code: "conflict" });

      const other = new Tasks({ store });
      const child = await other.create(
        { status: "active", title: "Child" },
        { parent: { id: root.id } }
      );
      const reader =
        db === undefined
          ? store
          : new SqliteTaskStore({
              database: db,
              maxParameters: 5,
              scope: `tasks-cas-${kind}`,
            });
      expect(await reader.list({ ids: [] })).toEqual([]);
      expect(
        (
          await reader.list({
            ids: [child.id, root.id, "tk-missing" as TaskId],
            parentId: root.id,
            status: "active",
          })
        ).map((t) => t.id)
      ).toEqual([child.id]);
    }
  );

  it("enforces parentGate on grandparents for same-batch { key } task.set_status(requireReady)", async () => {
    const store = new MemoryTaskStore();
    const tasks = new Tasks({ parentGate: true, store });
    const grandparent = await tasks.create({ title: "Grandparent" });
    const parent = await tasks.create(
      { status: "active", title: "Parent" },
      { parent: { id: grandparent.id } }
    );

    await expect(
      tasks.change({
        operations: [
          {
            input: { title: "Child" },
            key: "child",
            kind: "task.create",
            parent: { id: parent.id },
          },
          {
            kind: "task.set_status",
            requireReady: true,
            status: "active",
            task: { key: "child" },
          },
        ],
      })
    ).rejects.toMatchObject({
      code: "not_ready",
      message: expect.stringContaining(grandparent.id),
    });

    await tasks.start(grandparent.id);
    const result = await tasks.change({
      operations: [
        {
          input: { title: "Child" },
          key: "child",
          kind: "task.create",
          parent: { id: parent.id },
        },
        {
          kind: "task.set_status",
          requireReady: true,
          status: "active",
          task: { key: "child" },
        },
      ],
    });
    expect(result.tasks.find((t) => t.title === "Child")?.status).toBe(
      "active"
    );
  });

  it("guards expand() cycles/depth, caps applyChange operations, and makes taskPageSchema.total optional", async () => {
    const store = new MemoryTaskStore();
    const tasks = new Tasks({ store });
    const a = await tasks.create({ title: "A" });
    const b = await tasks.create({ title: "B" }, { parent: { id: a.id } });
    await store.commit({ putTasks: [{ ...a, parentId: b.id }] });

    const node = await tasks.get(a.id, { depth: 5 });
    expect(node?.subtasks?.map((t) => t.id)).toEqual([b.id]);
    expect(node?.subtasks?.[0]?.subtasks).toEqual([]);
    await expect(tasks.get(a.id, { depth: 100 })).rejects.toThrow(RangeError);

    const tooMany = Array.from(
      { length: MAX_OPERATIONS_PER_CHANGE + 1 },
      (_, i) => ({
        input: { title: `T${i}` },
        key: `k${i}`,
        kind: "task.create" as const,
      })
    );
    expect(() =>
      applyChange(
        { dependencies: [], tasks: [] },
        { operations: tooMany },
        () => "2026-01-01T00:00:00.000Z"
      )
    ).toThrow(TaskError);
    expect(taskPageSchema.parse({ items: [] })).toEqual({ items: [] });
  });
});
