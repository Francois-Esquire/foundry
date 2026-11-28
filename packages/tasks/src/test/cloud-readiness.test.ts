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

describe("Tasks cloud-native seams", () => {
  it("avoids snapshot() on create, update, set_status, availability, ready, and remove", async () => {
    const inner = new MemoryTaskStore();
    let snapshotCalls = 0;
    const spyingStore: TaskStore = {
      children: inner.children.bind(inner),
      commit: inner.commit.bind(inner),
      dependenciesOf: inner.dependenciesOf.bind(inner),
      get: inner.get.bind(inner),
      list: inner.list.bind(inner),
      snapshot() {
        snapshotCalls += 1;
        return inner.snapshot();
      },
    };

    const tasks = new Tasks({ store: spyingStore });
    const first = await tasks.create({ title: "First" });
    const second = await tasks.create({ title: "Second" });
    const updated = await tasks.update(first.id, { title: "First updated" });
    const started = await tasks.start(updated.id);
    const avail = await tasks.availability(second.id);
    const readyPage = await tasks.ready();
    await tasks.remove(second.id);

    expect(started.status).toBe("active");
    expect(avail).toEqual({ kind: "ready" });
    expect(readyPage.items.map((item) => item.id)).toEqual([second.id]);
    expect(snapshotCalls).toBe(0);
  });

  const databases = libsqlDatabases("memory");

  it.each(["memory", "sqlite"] as const)(
    "enforces expectedUpdatedAt CAS and store.list({ ids }) filtering in %s store",
    async (kind) => {
      const store =
        kind === "sqlite"
          ? new SqliteTaskStore({
              database: await databases.open(),
              scope: `tasks-cas-${kind}`,
            })
          : new MemoryTaskStore();
      const tasks = new Tasks({ store });
      const root = await tasks.create({ title: "Root" });
      const childOpen = await tasks.create(
        { title: "Child Open" },
        { parent: { id: root.id } }
      );
      const childActive = await tasks.create(
        { status: "active", title: "Child Active" },
        { parent: { id: root.id } }
      );
      const standalone = await tasks.create({ title: "Standalone" });

      expect(await store.list({ ids: [] })).toEqual([]);
      const selected = await store.list({
        ids: [
          standalone.id,
          root.id,
          root.id,
          "tk-missing" as TaskId,
          childOpen.id,
        ],
      });
      expect(selected.map((task) => task.id)).toEqual([
        root.id,
        childOpen.id,
        standalone.id,
      ]);

      const byIdsAndParent = await store.list({
        ids: [root.id, childOpen.id, childActive.id, standalone.id],
        parentId: root.id,
      });
      expect(byIdsAndParent.map((task) => task.id)).toEqual([
        childOpen.id,
        childActive.id,
      ]);

      const byIdsParentAndStatus = await store.list({
        ids: [root.id, childOpen.id, childActive.id, standalone.id],
        parentId: root.id,
        status: "active",
      });
      expect(byIdsParentAndStatus.map((task) => task.id)).toEqual([
        childActive.id,
      ]);

      const byIdsNullParentAndStatus = await store.list({
        ids: [root.id, childOpen.id, standalone.id],
        parentId: null,
        status: "open",
      });
      expect(byIdsNullParentAndStatus.map((task) => task.id)).toEqual([
        root.id,
        standalone.id,
      ]);

      await expect(
        store.commit({
          expectedUpdatedAt: { [root.id]: "2020-01-01T00:00:00.000Z" },
          putTasks: [{ ...root, title: "Stale" }],
        })
      ).rejects.toMatchObject({ code: "conflict" });
    }
  );

  it("chunks SQLite store.list({ ids }) across maxParameters while preserving position order and filters", async () => {
    const database = await databases.open();
    const writer = new SqliteTaskStore({ database, scope: "tasks-chunked" });
    const tasks = new Tasks({ store: writer });
    const root = await tasks.create({ title: "Root" });
    const created: TaskId[] = [];
    const expectedOpenChildren: TaskId[] = [];
    for (let index = 0; index < 20; index += 1) {
      const status = index % 2 === 0 ? "open" : "active";
      const parent = index % 3 === 0 ? undefined : { id: root.id };
      const task = await tasks.create(
        { status, title: `Task ${index}` },
        parent === undefined ? {} : { parent }
      );
      created.push(task.id);
      if (status === "open" && parent !== undefined) {
        expectedOpenChildren.push(task.id);
      }
    }

    const narrow = new SqliteTaskStore({
      database,
      maxParameters: 5,
      scope: "tasks-chunked",
    });
    const reversed = [...created].reverse();
    const all = await narrow.list({ ids: reversed });
    expect(all.map((task) => task.id)).toEqual(created);

    const filtered = await narrow.list({
      ids: [...reversed, root.id, "bad\u0000id" as TaskId],
      parentId: root.id,
      status: "open",
    });
    expect(filtered.map((task) => task.id)).toEqual(expectedOpenChildren);
  });

  it("enforces MAX_OPERATIONS_PER_CHANGE in applyChange and makes total optional in taskPageSchema", () => {
    const tooMany = Array.from(
      { length: MAX_OPERATIONS_PER_CHANGE + 1 },
      (_, index) => ({
        input: { title: `Task ${index}` },
        key: `k${index}`,
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

  it("guards expand() against cycles and excessive depth", async () => {
    const store = new MemoryTaskStore();
    const tasks = new Tasks({ store });
    const a = await tasks.create({ title: "A" });
    const b = await tasks.create({ title: "B" }, { parent: { id: a.id } });
    await store.commit({
      putTasks: [{ ...a, parentId: b.id }],
    });

    const node = await tasks.get(a.id, { depth: 5 });
    expect(node?.subtasks?.map((item) => item.id)).toEqual([b.id]);
    expect(node?.subtasks?.[0]?.subtasks).toEqual([]);

    await expect(tasks.get(a.id, { depth: 100 })).rejects.toThrow(RangeError);
  });

  it.each(["memory", "sqlite"] as const)(
    "rejects colliding generated and explicit IDs with conflict via expectedUpdatedAt: null on %s store",
    async (kind) => {
      const store =
        kind === "sqlite"
          ? new SqliteTaskStore({
              database: await databases.open(),
              scope: `tasks-id-collision-${kind}`,
            })
          : new MemoryTaskStore();

      const stuck = new Tasks({ id: () => "dup", store });
      const first = await stuck.create({ title: "Original" });
      expect(first.id).toBe("tk-dup");

      await expect(
        stuck.create({ title: "Generated collision" })
      ).rejects.toMatchObject({ code: "conflict" });
      expect((await stuck.get(first.id))?.title).toBe("Original");

      await expect(
        stuck.create({ id: first.id, title: "Explicit overwrite" })
      ).rejects.toMatchObject({ code: "conflict" });
      expect((await stuck.get(first.id))?.title).toBe("Original");

      const sequence = ["intra", "intra", "intra-2", "ev-batch"];
      let index = 0;
      const batched = new Tasks({
        id: () => {
          const next = sequence[index] ?? `fallback-${index}`;
          index += 1;
          return next;
        },
        store,
      });
      const result = await batched.change({
        operations: [
          { input: { title: "First in batch" }, key: "a", kind: "task.create" },
          {
            input: { title: "Second in batch" },
            key: "b",
            kind: "task.create",
          },
        ],
      });
      expect(result.tasks.map((task) => task.id)).toEqual([
        "tk-intra",
        "tk-intra-2",
      ]);
    }
  );

  it.each(["memory", "sqlite"] as const)(
    "concurrent non-transactional task.create with same explicit ID conflicts on the second write in %s store",
    async (kind) => {
      const backing =
        kind === "sqlite"
          ? new SqliteTaskStore({
              database: await databases.open(),
              scope: `tasks-concurrent-create-${kind}`,
            })
          : new MemoryTaskStore();

      let readsAtBarrier = 0;
      const bothRead = Promise.withResolvers<void>();
      const nonTransactionalStore: TaskStore = {
        commit: backing.commit.bind(backing),
        get: backing.get.bind(backing),
        list: async (query?: TaskStoreListQuery) => {
          const rows = await backing.list(query);
          readsAtBarrier += 1;
          if (readsAtBarrier === 2) {
            bothRead.resolve();
          }
          await bothRead.promise;
          return rows;
        },
        snapshot: backing.snapshot.bind(backing),
      };

      const writerA = new Tasks({ store: nonTransactionalStore });
      const writerB = new Tasks({ store: nonTransactionalStore });

      const results = await Promise.allSettled([
        writerA.create({ id: "tk-race", title: "From A" }),
        writerB.create({ id: "tk-race", title: "From B" }),
      ]);

      const fulfilled = results.filter((item) => item.status === "fulfilled");
      const rejected = results.filter((item) => item.status === "rejected");
      expect(fulfilled).toHaveLength(1);
      expect(rejected).toHaveLength(1);
      expect(rejected[0]?.reason).toMatchObject({ code: "conflict" });
      const stored = await backing.get("tk-race" as TaskId);
      expect(stored?.title).toBe(fulfilled[0]?.value.title);
    }
  );

  it.each(["memory", "sqlite"] as const)(
    "enforces parentGate on grandparents for same-batch { key } task.set_status(requireReady) in %s store",
    async (kind) => {
      const backing =
        kind === "sqlite"
          ? new SqliteTaskStore({
              database: await databases.open(),
              scope: `tasks-parent-gate-key-${kind}`,
            })
          : new MemoryTaskStore();
      let snapshotCalls = 0;
      const store: TaskStore = {
        children: backing.children.bind(backing),
        commit: backing.commit.bind(backing),
        dependenciesOf: backing.dependenciesOf.bind(backing),
        get: backing.get.bind(backing),
        list: backing.list.bind(backing),
        snapshot() {
          snapshotCalls += 1;
          return backing.snapshot();
        },
      };

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

      await expect(
        tasks.change({
          operations: [
            {
              input: { status: "active", title: "Mid" },
              key: "mid",
              kind: "task.create",
              parent: { id: parent.id },
            },
            {
              input: { title: "Leaf" },
              key: "leaf",
              kind: "task.create",
              parent: { key: "mid" },
            },
            {
              kind: "task.set_status",
              requireReady: true,
              status: "active",
              task: { key: "leaf" },
            },
          ],
        })
      ).rejects.toMatchObject({
        code: "not_ready",
        message: expect.stringContaining(grandparent.id),
      });

      await tasks.start(grandparent.id);
      const started = await tasks.change({
        operations: [
          {
            input: { status: "active", title: "Mid" },
            key: "mid",
            kind: "task.create",
            parent: { id: parent.id },
          },
          {
            input: { title: "Leaf" },
            key: "leaf",
            kind: "task.create",
            parent: { key: "mid" },
          },
          {
            kind: "task.set_status",
            requireReady: true,
            status: "active",
            task: { key: "leaf" },
          },
        ],
      });
      const leaf = started.tasks.find((task) => task.title === "Leaf");
      expect(leaf?.status).toBe("active");
      expect(snapshotCalls).toBe(0);
    }
  );

  it("batches related task lookups in #relationsFor via store.list({ ids }) without N+1 get() calls", async () => {
    const inner = new MemoryTaskStore();
    const tasksSetup = new Tasks({ store: inner });
    const pre1 = await tasksSetup.create({ title: "Pre 1" });
    const pre2 = await tasksSetup.create({ title: "Pre 2" });
    const pre3 = await tasksSetup.create({ title: "Pre 3" });
    const center = await tasksSetup.create(
      { title: "Center" },
      { dependsOn: [{ id: pre1.id }, { id: pre2.id }, { id: pre3.id }] }
    );
    const dep1 = await tasksSetup.create(
      { title: "Dep 1" },
      { dependsOn: [{ id: center.id }] }
    );
    const dep2 = await tasksSetup.create(
      { title: "Dep 2" },
      { dependsOn: [{ id: center.id }] }
    );
    const dep3 = await tasksSetup.create(
      { title: "Dep 3" },
      { dependsOn: [{ id: center.id }] }
    );

    const getCalls: TaskId[] = [];
    const listQueries: (TaskStoreListQuery | undefined)[] = [];
    let snapshotCalls = 0;
    const spyingStore: TaskStore = {
      children: inner.children.bind(inner),
      commit: inner.commit.bind(inner),
      dependenciesOf: inner.dependenciesOf.bind(inner),
      get(id) {
        getCalls.push(id);
        return inner.get(id);
      },
      list(query) {
        listQueries.push(query);
        return inner.list(query);
      },
      snapshot() {
        snapshotCalls += 1;
        return inner.snapshot();
      },
    };

    const tasks = new Tasks({ store: spyingStore });
    const relations = await tasks.dependencies(center.id);
    expect(relations.dependsOn.map((task) => task.id)).toEqual([
      pre1.id,
      pre2.id,
      pre3.id,
    ]);
    expect(relations.dependents.map((task) => task.id)).toEqual([
      dep1.id,
      dep2.id,
      dep3.id,
    ]);
    expect(getCalls).toEqual([center.id]);
    expect(listQueries).toHaveLength(1);
    expect(new Set(listQueries[0]?.ids)).toEqual(
      new Set([pre1.id, pre2.id, pre3.id, dep1.id, dep2.id, dep3.id])
    );

    const withRelations = await tasks.getWithRelations(center.id);
    expect(withRelations?.dependsOn.map((task) => task.id)).toEqual([
      pre1.id,
      pre2.id,
      pre3.id,
    ]);
    expect(withRelations?.dependents.map((task) => task.id)).toEqual([
      dep1.id,
      dep2.id,
      dep3.id,
    ]);
    expect(getCalls).toEqual([center.id, center.id]);
    expect(listQueries).toHaveLength(2);
    expect(snapshotCalls).toBe(0);
  });
});
