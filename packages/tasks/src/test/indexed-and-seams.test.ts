import { describe, expect, test, vi } from "vitest";
import type { TaskStore } from "../store/index";
import { MemoryTaskStore } from "../store/memory";
import { Tasks } from "../tasks";
import { describeTaskStore } from "../testing/store";

const clock = () => new Date("2026-10-29T00:00:00.000Z");

describe("Tasks indexed store reads and injectable id seam", () => {
  test("uses indexed store methods instead of snapshot() for depth-0 reads and dependencies", async () => {
    const store = new MemoryTaskStore();
    const tasks = new Tasks({ clock, store });
    const root = await tasks.create({ title: "Root" });
    const child = await tasks.create(
      { title: "Child" },
      { parent: { id: root.id } }
    );
    const dep = await tasks.create(
      { title: "Dep" },
      { dependsOn: [{ id: child.id }] }
    );

    const snapshotSpy = vi.spyOn(MemoryTaskStore.prototype, "snapshot");
    const listSpy = vi.spyOn(MemoryTaskStore.prototype, "list");
    const childrenSpy = vi.spyOn(MemoryTaskStore.prototype, "children");
    const depsSpy = vi.spyOn(MemoryTaskStore.prototype, "dependenciesOf");
    try {
      const listed = await tasks.list({ parentId: root.id, status: "open" });
      expect(listed.items.map((item) => item.id)).toEqual([child.id]);
      expect(listSpy).toHaveBeenCalledTimes(1);

      const kids = await tasks.children(root.id);
      expect(kids.map((item) => item.id)).toEqual([child.id]);
      expect(childrenSpy).toHaveBeenCalledTimes(1);

      const relations = await tasks.dependencies(child.id);
      expect(relations.dependents.map((item) => item.id)).toEqual([dep.id]);
      expect(relations.dependsOn).toEqual([]);
      expect(depsSpy).toHaveBeenCalledWith([child.id]);

      const withRel = await tasks.getWithRelations(child.id);
      expect(withRel?.id).toBe(child.id);
      expect(withRel?.dependents.map((item) => item.id)).toEqual([dep.id]);

      expect(snapshotSpy).not.toHaveBeenCalled();
    } finally {
      vi.restoreAllMocks();
    }
  });

  test("falls back to snapshot() when a store omits optional indexed methods", async () => {
    const backing = new MemoryTaskStore();
    const minimal: TaskStore = {
      commit: (write) => backing.commit(write),
      get: (id) => backing.get(id),
      snapshot: () => backing.snapshot(),
      transaction: (work) => backing.transaction(work),
    };
    const tasks = new Tasks({ clock, store: minimal });
    const root = await tasks.create({ title: "Root" });
    const child = await tasks.create(
      { title: "Child" },
      { dependsOn: [{ id: root.id }], parent: { id: root.id } }
    );

    expect((await tasks.list({ parentId: root.id })).items).toEqual([child]);
    expect(await tasks.children(root.id)).toEqual([child]);
    expect((await tasks.dependencies(child.id)).dependsOn).toEqual([root]);
    expect((await tasks.getWithRelations(child.id))?.dependsOn).toEqual([root]);
  });

  test("uses injected id generator for task ids and event ids", async () => {
    const events: string[] = [];
    const backing = new MemoryTaskStore();
    const recordingStore: TaskStore = {
      commit: async (write) => {
        for (const event of write.events ?? []) {
          events.push(event.id);
        }
        await backing.commit(write);
      },
      get: (id) => backing.get(id),
      snapshot: () => backing.snapshot(),
    };
    let seq = 0;
    const tasks = new Tasks({
      clock,
      id: () => {
        seq += 1;
        return `0000000${String(seq)}-0000-4000-8000-000000000000`;
      },
      store: recordingStore,
    });

    const first = await tasks.create({ title: "First" });
    const second = await tasks.create({ title: "Second" });
    await tasks.remove(second.id);

    expect(first.id).toBe("tk-00000001");
    expect(second.id).toBe("tk-00000003");
    expect(events).toEqual([
      "00000002-0000-4000-8000-000000000000",
      "00000004-0000-4000-8000-000000000000",
      "00000005-0000-4000-8000-000000000000",
    ]);
  });
});

function withoutInsertionOrder(store: TaskStore): TaskStore {
  const wrap = (inner: TaskStore): TaskStore => {
    const base: TaskStore = {
      commit: (write) => inner.commit(write),
      get: (id) => inner.get(id),
      snapshot: async () => {
        const snap = await inner.snapshot();
        return {
          dependencies: [...snap.dependencies].sort((a, b) =>
            a.taskId === b.taskId
              ? a.dependsOnId.localeCompare(b.dependsOnId)
              : a.taskId.localeCompare(b.taskId)
          ),
          tasks: [...snap.tasks].sort((a, b) => {
            if (a.createdAt !== b.createdAt) {
              return a.createdAt < b.createdAt ? -1 : 1;
            }
            if (a.id === b.id) {
              return 0;
            }
            return a.id < b.id ? -1 : 1;
          }),
        };
      },
    };
    const transaction = inner.transaction?.bind(inner);
    return transaction === undefined
      ? base
      : {
          ...base,
          transaction: <T>(work: (view: TaskStore) => Promise<T>) =>
            transaction((view) => work(wrap(view))),
        };
  };
  return wrap(store);
}

describeTaskStore(
  "Cloud-style TaskStore (createdAt + id ordering)",
  () => {
    const stores = new Map<string, TaskStore>();
    return (scope) => {
      const existing = stores.get(scope);
      if (existing) {
        return existing;
      }
      const created = withoutInsertionOrder(new MemoryTaskStore());
      stores.set(scope, created);
      return created;
    };
  },
  { insertionOrder: false }
);
