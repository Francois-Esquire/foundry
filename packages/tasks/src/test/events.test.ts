import { describe, expect, test } from "vitest";
import { TaskError } from "../errors";
import type { TaskSnapshot, TaskStore, TaskStoreWrite } from "../store";
import { MemoryTaskStore } from "../store";
import { Tasks } from "../tasks";
import type { TaskEvent } from "../types";

const clock = () => new Date("2026-10-29T00:00:00.000Z");

/** A memory store that keeps every write it committed. */
class RecordingStore extends MemoryTaskStore {
  readonly writes: TaskStoreWrite[] = [];

  override commit(write: TaskStoreWrite): Promise<void> {
    this.writes.push(structuredClone(write));
    return super.commit(write);
  }

  events(): TaskEvent[] {
    return this.writes.flatMap((write) => (write.event ? [write.event] : []));
  }
}

function recorded(): { store: RecordingStore; tasks: Tasks } {
  const store = new RecordingStore();
  return { store, tasks: new Tasks({ clock, store }) };
}

describe("task change events", () => {
  test("a create carries the new record and its edges, not the tasks it named", async () => {
    const { store, tasks } = recorded();
    const parent = await tasks.create({ title: "Parent" });
    const target = await tasks.create({ title: "Target" });
    const child = await tasks.create(
      { tags: ["review"], title: "Child" },
      { dependsOn: [{ id: target.id }], parent: { id: parent.id } }
    );

    const event = store.events().at(-1);
    expect(event).toEqual({
      dependencies: {
        added: [{ dependsOnId: target.id, taskId: child.id }],
        removed: [],
      },
      kind: "tasks.changed",
      tasks: [{ after: child, before: null, id: child.id }],
    });
  });

  test("before and after span the whole batch, once per task", async () => {
    const { store, tasks } = recorded();
    const task = await tasks.create({ tags: ["review"], title: "T" });
    await tasks.change({
      operations: [
        { kind: "task.update", patch: { tags: [] }, task: { id: task.id } },
        { kind: "task.set_status", status: "active", task: { id: task.id } },
        { kind: "task.update", patch: { title: "U" }, task: { id: task.id } },
      ],
    });

    const event = store.events().at(-1);
    expect(event?.tasks).toHaveLength(1);
    expect(event?.tasks[0]?.before).toEqual(task);
    expect(event?.tasks[0]?.after).toMatchObject({
      status: "active",
      tags: [],
      title: "U",
    });
    // The removed tag stays in this event, whatever happens to the task later.
    await tasks.update(task.id, { tags: ["other"] });
    expect(event?.tasks[0]?.before?.tags).toEqual(["review"]);
  });

  test("edge-only batches carry edges and no tasks; a round trip nets to nothing", async () => {
    const { store, tasks } = recorded();
    const a = await tasks.create({ title: "A" });
    const b = await tasks.create({ title: "B" });
    const c = await tasks.create({ title: "C" });
    await tasks.change({
      operations: [
        { dependsOn: { id: b.id }, kind: "dependency.add", task: { id: a.id } },
      ],
    });
    expect(store.events().at(-1)).toEqual({
      dependencies: {
        added: [{ dependsOnId: b.id, taskId: a.id }],
        removed: [],
      },
      kind: "tasks.changed",
      tasks: [],
    });

    const before = store.events().length;
    // Remove then re-add an existing edge, and add then remove a new one.
    await tasks.change({
      operations: [
        {
          dependsOn: { id: b.id },
          kind: "dependency.remove",
          task: { id: a.id },
        },
        { dependsOn: { id: b.id }, kind: "dependency.add", task: { id: a.id } },
        { dependsOn: { id: c.id }, kind: "dependency.add", task: { id: a.id } },
        {
          dependsOn: { id: c.id },
          kind: "dependency.remove",
          task: { id: a.id },
        },
      ],
    });
    expect(store.events()).toHaveLength(before);
  });

  test("a batch that changes nothing commits no event", async () => {
    const { store, tasks } = recorded();
    const parent = await tasks.create({ title: "Parent" });
    const task = await tasks.create(
      { title: "T" },
      { parent: { id: parent.id } }
    );
    const before = store.events().length;
    await tasks.change({
      operations: [
        { kind: "task.set_status", status: "open", task: { id: task.id } },
        { kind: "task.move", parent: { id: parent.id }, task: { id: task.id } },
      ],
    });
    expect(store.events()).toHaveLength(before);
  });

  test("a refused batch commits nothing", async () => {
    const { store, tasks } = recorded();
    const task = await tasks.create({ title: "T" });
    const before = store.writes.length;
    await expect(
      tasks.change({
        operations: [
          { kind: "task.update", patch: { title: "U" }, task: { id: task.id } },
          { kind: "task.update", patch: {}, task: { id: "tk-missing" } },
        ],
      })
    ).rejects.toThrow();
    expect(store.writes).toHaveLength(before);
  });

  test("remove carries the removed record and every edge it dropped", async () => {
    const { store, tasks } = recorded();
    const a = await tasks.create({ title: "A" });
    const b = await tasks.create({ title: "B" }, { dependsOn: [{ id: a.id }] });
    const c = await tasks.create({ title: "C" }, { dependsOn: [{ id: b.id }] });
    await tasks.remove(b.id);

    expect(store.events().at(-1)).toEqual({
      dependencies: {
        added: [],
        removed: [
          { dependsOnId: a.id, taskId: b.id },
          { dependsOnId: b.id, taskId: c.id },
        ],
      },
      kind: "tasks.changed",
      tasks: [{ after: null, before: b, id: b.id }],
    });
  });
});

/**
 * A memory store whose transactions hold one store-wide turn, with a pause
 * after every read so an unguarded writer would interleave.
 */
class TransactionalStore implements TaskStore {
  readonly #inner = new MemoryTaskStore();
  #turn: Promise<unknown> = Promise.resolve();

  commit(write: TaskStoreWrite): Promise<void> {
    return this.#inner.commit(write);
  }

  get(id: Parameters<TaskStore["get"]>[0]) {
    return this.#inner.get(id);
  }

  async snapshot(): Promise<TaskSnapshot> {
    const snapshot = await this.#inner.snapshot();
    await new Promise((resolve) => setTimeout(resolve, 5));
    return snapshot;
  }

  transaction<T>(work: (view: TaskStore) => Promise<T>): Promise<T> {
    const run = this.#turn.then(() => work(this));
    this.#turn = run.catch(() => undefined);
    return run;
  }
}

describe("store transactions", () => {
  test("two instances over a transactional store cannot close a cycle", async () => {
    const store = new TransactionalStore();
    const first = new Tasks({ clock, store });
    const second = new Tasks({ clock, store });
    const a = await first.create({ title: "A" });
    const b = await first.create({ title: "B" });

    const results = await Promise.allSettled([
      first.change({
        operations: [
          {
            dependsOn: { id: b.id },
            kind: "dependency.add",
            task: { id: a.id },
          },
        ],
      }),
      second.change({
        operations: [
          {
            dependsOn: { id: a.id },
            kind: "dependency.add",
            task: { id: b.id },
          },
        ],
      }),
    ]);

    expect(results.map((result) => result.status).sort()).toEqual([
      "fulfilled",
      "rejected",
    ]);
    expect((await store.snapshot()).dependencies).toHaveLength(1);
  });

  test("inUse may write through another instance over the store while remove waits on it", async () => {
    const store = new TransactionalStore();
    const writer = new Tasks({ clock, store });
    const other = await writer.create({ title: "Other" });
    const guarded = new Tasks({
      clock,
      inUse: async () => {
        await writer.update(other.id, { title: "Checked" });
        return false;
      },
      store,
    });
    const target = await guarded.create({ title: "Target" });

    await expect(guarded.remove(target.id)).resolves.toMatchObject({
      id: target.id,
    });
    // The store's turn was handed back: later writes go through.
    await writer.update(other.id, { title: "After" });
    const titles = (await store.snapshot()).tasks.map((task) => task.title);
    expect(titles).toEqual(["After"]);
  });

  test("remove checks the task again after inUse, against the store as it is then", async () => {
    const store = new TransactionalStore();
    const writer = new Tasks({ clock, store });
    let during: (id: string) => Promise<unknown> = () => Promise.resolve();
    const guarded = new Tasks({
      clock,
      inUse: async (id) => {
        await during(id);
        return false;
      },
      store,
    });
    const code = async (work: Promise<unknown>) => {
      try {
        await work;
      } catch (error) {
        return error instanceof TaskError ? error.code : String(error);
      }
      return "removed";
    };

    // A child placed under it while inUse ran.
    const parent = await guarded.create({ title: "Parent" });
    during = (id) => writer.create({ title: "Child" }, { parent: { id } });
    expect(await code(guarded.remove(parent.id))).toBe("invalid_operation");

    // Changed past the caller's token while inUse ran.
    const tokened = await guarded.create({ title: "Tokened" });
    during = (id) => writer.update(id, { title: "Moved on" });
    expect(
      await code(
        guarded.remove(tokened.id, { expectedUpdatedAt: tokened.updatedAt })
      )
    ).toBe("conflict");

    // Removed by someone else while inUse ran.
    const gone = await guarded.create({ title: "Gone" });
    during = (id) => writer.remove(id);
    expect(await code(guarded.remove(gone.id))).toBe("not_found");

    // Without a token, the record as it is at commit is the one removed, and
    // an edge added meanwhile is dropped with it.
    const target = await guarded.create({ title: "Target" });
    const anchor = await guarded.create({ title: "Anchor" });
    during = async (id) => {
      await writer.update(id, { tags: ["late"] });
      await writer.change({
        operations: [
          {
            dependsOn: { id: anchor.id },
            kind: "dependency.add",
            task: { id },
          },
        ],
      });
    };
    const removed = await guarded.remove(target.id);
    expect(removed.tags).toEqual(["late"]);
    const { dependencies, tasks } = await store.snapshot();
    expect(tasks.map((task) => task.id)).not.toContain(target.id);
    expect(dependencies).toEqual([]);
  });
});
