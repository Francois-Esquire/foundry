import { describe, expect, test } from "vitest";
import type { Task, TaskDependency, TaskEvent, TaskId } from "../schema";
import type { TaskStore } from "../store/index";

/**
 * Fresh, empty storage, reached one scope at a time. The same scope reaches
 * the same records on every call; two scopes never see each other's. A store
 * that has no scopes keeps one store per scope name.
 */
export type ScopedTaskStores = (scope: string) => TaskStore;

/**
 * The behaviour every `TaskStore` shares, as Vitest tests. `open` returns new,
 * empty storage each time it is called. The host's test file closes whatever
 * `open` opened.
 */
export function describeTaskStore(
  name: string,
  open: () => ScopedTaskStores | Promise<ScopedTaskStores>
): void {
  async function store(scope = "scope-a"): Promise<TaskStore> {
    return (await open())(scope);
  }

  describe(`${name} task store conformance`, () => {
    test("an empty store has no tasks and no edges", async () => {
      const empty = await store();
      expect(await empty.get(id("missing"))).toBeNull();
      expect(await empty.snapshot()).toEqual({ dependencies: [], tasks: [] });
    });

    test("a commit puts tasks and edges, and reads return them whole", async () => {
      const target = await store();
      const root = task("root");
      const child = task("child", {
        description: "under root",
        metadata: { nested: { list: [1, "two", null, true] }, size: "m" },
        parentId: root.id,
        settledAt: "2026-11-02T00:00:00.000Z",
        status: "completed",
        tags: ["", "review", "Review"],
      });
      const edge = dependency(child, root);
      await target.commit({ putDependencies: [edge], putTasks: [root, child] });

      expect(await target.get(root.id)).toEqual(root);
      expect(await target.get(child.id)).toEqual(child);
      expect(await target.snapshot()).toEqual({
        dependencies: [edge],
        tasks: [root, child],
      });
    });

    test("reads list records in the order first put; a put over one keeps its place", async () => {
      const target = await store();
      const [a, b, c] = [task("a"), task("b"), task("c")];
      await target.commit({ putTasks: [b] });
      await target.commit({
        putDependencies: [dependency(b, a), dependency(a, c)],
        putTasks: [a, c],
      });
      const renamed = { ...b, title: "b renamed" };
      await target.commit({
        putDependencies: [dependency(b, a)],
        putTasks: [renamed],
      });

      const snapshot = await target.snapshot();
      expect(snapshot.tasks).toEqual([renamed, a, c]);
      expect(snapshot.dependencies).toEqual([
        dependency(b, a),
        dependency(a, c),
      ]);
    });

    test("deletes apply before puts, so a record deleted and put again moves last", async () => {
      const target = await store();
      const [a, b, c] = [task("a"), task("b"), task("c")];
      await target.commit({
        putDependencies: [dependency(a, b), dependency(b, c)],
        putTasks: [a, b, c],
      });
      const again = { ...a, title: "a again" };
      await target.commit({
        deleteDependencies: [dependency(a, b)],
        deleteTasks: [a.id],
        putDependencies: [dependency(a, b)],
        putTasks: [again],
      });

      expect(await target.snapshot()).toEqual({
        dependencies: [dependency(b, c), dependency(a, b)],
        tasks: [b, c, again],
      });
    });

    test("deletes remove only what they name, and missing records are no-ops", async () => {
      const target = await store();
      const [a, b] = [task("a"), task("b")];
      await target.commit({
        putDependencies: [dependency(a, b), dependency(b, a)],
        putTasks: [a, b],
      });
      await target.commit({
        deleteDependencies: [dependency(a, b), dependency(a, task("x"))],
        deleteTasks: [a.id, id("x")],
      });

      expect(await target.get(a.id)).toBeNull();
      // The store enforces nothing: an edge outlives the task it names.
      expect(await target.snapshot()).toEqual({
        dependencies: [dependency(b, a)],
        tasks: [b],
      });
    });

    test("an empty write changes nothing", async () => {
      const target = await store();
      const a = task("a");
      await target.commit({ putTasks: [a] });
      await target.commit({});
      await target.commit({
        deleteDependencies: [],
        deleteTasks: [],
        putDependencies: [],
        putTasks: [],
      });

      expect(await target.snapshot()).toEqual({
        dependencies: [],
        tasks: [a],
      });
    });

    test("a write's event changes no record", async () => {
      const target = await store();
      const a = task("a");
      const event: TaskEvent = {
        dependencies: { added: [], removed: [] },
        kind: "tasks.changed",
        tasks: [{ after: a, before: null, id: a.id }],
      };
      await target.commit({ event, putTasks: [a] });

      expect(await target.snapshot()).toEqual({
        dependencies: [],
        tasks: [a],
      });
    });

    test("a failing commit leaves nothing behind", async () => {
      const target = await store();
      const [kept, edgeTarget] = [task("kept"), task("edge-target")];
      const edge = dependency(kept, edgeTarget);
      await target.commit({ putDependencies: [edge], putTasks: [kept] });

      const poisoned = task("poisoned", { metadata: unreadable() });
      await expect(
        target.commit({
          deleteDependencies: [edge],
          deleteTasks: [kept.id],
          putDependencies: [dependency(task("new"), kept)],
          putTasks: [task("new"), poisoned],
        })
      ).rejects.toThrow("unreadable");

      expect(await target.snapshot()).toEqual({
        dependencies: [edge],
        tasks: [kept],
      });
    });

    test("reads are detached from the store", async () => {
      const target = await store();
      const a = task("a", { metadata: { list: ["x"] }, tags: ["t"] });
      await target.commit({
        putDependencies: [dependency(a, a)],
        putTasks: [a],
      });

      const read = mutable(await target.get(a.id));
      read.title = "changed";
      (read.metadata.list as string[]).push("y");
      (read.tags as string[]).push("u");
      const snapshot = await target.snapshot();
      mutable(snapshot.tasks[0]).title = "changed";
      mutable(snapshot.dependencies[0]).dependsOnId = id("other");

      expect(await target.get(a.id)).toEqual(a);
      expect(await target.snapshot()).toEqual({
        dependencies: [dependency(a, a)],
        tasks: [a],
      });
    });

    test("a committed write is detached from the caller's values", async () => {
      const target = await store();
      const a = task("a", { metadata: { list: ["x"] }, tags: ["t"] });
      const written = structuredClone(a);
      const edge = { ...dependency(a, a) };
      await target.commit({ putDependencies: [edge], putTasks: [written] });

      mutable(written).title = "changed";
      (written.metadata.list as string[]).push("y");
      (written.tags as string[]).push("u");
      mutable(edge).dependsOnId = id("other");

      expect(await target.snapshot()).toEqual({
        dependencies: [dependency(a, a)],
        tasks: [a],
      });
    });

    test("two scopes on one storage never see each other", async () => {
      const stores = await open();
      const [first, second] = [stores("scope-a"), stores("scope-b")];
      const a = task("shared-id", { title: "in a" });
      const b = task("shared-id", { title: "in b" });
      await first.commit({
        putDependencies: [dependency(a, a)],
        putTasks: [a],
      });

      expect(await second.get(a.id)).toBeNull();
      expect(await second.snapshot()).toEqual({ dependencies: [], tasks: [] });

      await second.commit({ putTasks: [b] });
      await second.commit({
        deleteDependencies: [dependency(a, a)],
        deleteTasks: [b.id],
      });

      expect(await first.get(a.id)).toEqual(a);
      expect(await first.snapshot()).toEqual({
        dependencies: [dependency(a, a)],
        tasks: [a],
      });
      expect(await stores("scope-a").get(a.id)).toEqual(a);
    });

    test("a transaction reads its own commits and returns what its work returns", async () => {
      const target = await store();
      const a = task("a");
      const result = await transactionOf(target)(async (view) => {
        await view.commit({
          putDependencies: [dependency(a, a)],
          putTasks: [a],
        });
        expect(await view.get(a.id)).toEqual(a);
        expect(await view.snapshot()).toEqual({
          dependencies: [dependency(a, a)],
          tasks: [a],
        });
        return "done";
      });

      expect(result).toBe("done");
      expect(await target.get(a.id)).toEqual(a);
    });

    test("a transaction whose work throws leaves nothing, and the next one runs", async () => {
      const target = await store();
      const [kept, lost] = [task("kept"), task("lost")];
      await target.commit({ putTasks: [kept] });

      await expect(
        transactionOf(target)(async (view) => {
          await view.commit({ deleteTasks: [kept.id], putTasks: [lost] });
          throw new Error("work failed");
        })
      ).rejects.toThrow("work failed");
      expect(await target.snapshot()).toEqual({
        dependencies: [],
        tasks: [kept],
      });

      await transactionOf(target)((view) => view.commit({ putTasks: [lost] }));
      expect(await target.get(lost.id)).toEqual(lost);
    });

    test("a write from outside cannot land between a transaction's read and its commit", async () => {
      const target = await store();
      const a = task("a");
      await target.commit({ putTasks: [a] });
      const outside = { ...a, title: "outside" };
      const inside = { ...a, title: "inside" };
      let landed: Promise<void> = Promise.resolve();

      const seen = await transactionOf(target)(async (view) => {
        const before = await view.get(a.id);
        landed = target.commit({ putTasks: [outside] });
        // Time enough for a write that is not held back to land.
        await new Promise((resolve) => setTimeout(resolve, 20));
        const after = await view.get(a.id);
        await view.commit({ putTasks: [inside] });
        return { after, before };
      });
      await landed;

      expect(seen).toEqual({ after: a, before: a });
      expect(await target.get(a.id)).toEqual(outside);
    });
  });
}

/** The store's `transaction`; every store this suite describes has one. */
function transactionOf(
  store: TaskStore
): NonNullable<TaskStore["transaction"]> {
  const { transaction } = store;
  if (transaction === undefined) {
    throw new Error("the store has no transaction(work)");
  }
  return transaction.bind(store);
}

function id(value: string): TaskId {
  return value as TaskId;
}

/** A complete root task; `overrides` sets any field. */
function task(name: string, overrides: Partial<Task> = {}): Task {
  return {
    createdAt: "2026-11-01T00:00:00.000Z",
    description: null,
    id: id(name),
    metadata: {},
    parentId: null,
    settledAt: null,
    status: "open",
    tags: [],
    title: name,
    updatedAt: "2026-11-01T00:00:00.000Z",
    ...overrides,
  };
}

function dependency(from: Task, on: Task): TaskDependency {
  return { dependsOnId: on.id, taskId: from.id };
}

/** Metadata that throws when read, so no store can copy or encode it. */
function unreadable(): Task["metadata"] {
  return Object.defineProperty({}, "value", {
    enumerable: true,
    get() {
      throw new Error("unreadable metadata");
    },
  });
}

/** Drops `readonly` so a test can try to change what a store handed out. */
function mutable<T>(value: T | null | undefined): {
  -readonly [K in keyof T]: T[K];
} {
  if (value === null || value === undefined) {
    throw new Error("expected a value");
  }
  return value;
}
