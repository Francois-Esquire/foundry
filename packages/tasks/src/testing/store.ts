import { describe, expect, test } from "vitest";
import type {
  Task,
  TaskDependency,
  TaskEvent,
  TaskId,
  TaskSnapshot,
} from "../schema";
import type { TaskStore } from "../store/index";

export type ScopedTaskStores = (scope: string) => TaskStore;

export interface TaskStoreCapabilities {
  readonly insertionOrder?: boolean;
  readonly reentrancyGuard?: boolean;
  readonly transactions?: boolean;
}

export function describeTaskStore(
  name: string,
  open: () => ScopedTaskStores | Promise<ScopedTaskStores>,
  capabilities: TaskStoreCapabilities = {}
): void {
  const insertionOrder = capabilities.insertionOrder ?? true;
  const transactions = capabilities.transactions ?? true;
  const reentrancyGuard = capabilities.reentrancyGuard ?? transactions;
  const normalizeTasks = (items: readonly Task[]): readonly Task[] =>
    insertionOrder
      ? items
      : [...items].sort((a, b) => {
          if (a.createdAt !== b.createdAt) {
            return a.createdAt < b.createdAt ? -1 : 1;
          }
          if (a.id === b.id) {
            return 0;
          }
          return a.id < b.id ? -1 : 1;
        });
  const normalizeEdges = (
    items: readonly TaskDependency[]
  ): readonly TaskDependency[] =>
    insertionOrder
      ? items
      : [...items].sort((a, b) => {
          if (a.taskId !== b.taskId) {
            return a.taskId < b.taskId ? -1 : 1;
          }
          if (a.dependsOnId === b.dependsOnId) {
            return 0;
          }
          return a.dependsOnId < b.dependsOnId ? -1 : 1;
        });
  const normalizeSnapshot = (snapshot: TaskSnapshot): TaskSnapshot =>
    insertionOrder
      ? snapshot
      : {
          dependencies: normalizeEdges(snapshot.dependencies),
          tasks: normalizeTasks(snapshot.tasks),
        };
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
      expect(normalizeSnapshot(await target.snapshot())).toEqual(
        normalizeSnapshot({
          dependencies: [edge],
          tasks: [root, child],
        })
      );
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

      const snapshot = normalizeSnapshot(await target.snapshot());
      expect(snapshot.tasks).toEqual(normalizeTasks([renamed, a, c]));
      expect(snapshot.dependencies).toEqual(
        normalizeEdges([dependency(b, a), dependency(a, c)])
      );
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

      expect(normalizeSnapshot(await target.snapshot())).toEqual(
        normalizeSnapshot({
          dependencies: [dependency(b, c), dependency(a, b)],
          tasks: [b, c, again],
        })
      );
    });

    test("a record put after the last one was deleted lists after every survivor", async () => {
      const target = await store();
      const [a, b, c, d] = [task("a"), task("b"), task("c"), task("d")];
      await target.commit({
        putDependencies: [dependency(a, b), dependency(b, c)],
        putTasks: [a, b, c],
      });
      await target.commit({
        deleteDependencies: [dependency(b, c)],
        deleteTasks: [c.id],
      });
      await target.commit({
        putDependencies: [dependency(d, a), dependency(b, c)],
        putTasks: [d, c],
      });
      await target.commit({ putTasks: [{ ...a, title: "a again" }] });

      expect(normalizeSnapshot(await target.snapshot())).toEqual(
        normalizeSnapshot({
          dependencies: [dependency(a, b), dependency(d, a), dependency(b, c)],
          tasks: [{ ...a, title: "a again" }, b, d, c],
        })
      );
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

    test("a write's events change no record", async () => {
      const target = await store();
      const a = task("a");
      const event: TaskEvent = {
        at: a.createdAt,
        dependencies: { added: [], removed: [] },
        id: "event-a",
        tasks: [{ after: a, before: null, id: a.id }],
        type: "tasks.changed",
      };
      await target.commit({ events: [event], putTasks: [a] });

      expect(await target.snapshot()).toEqual({
        dependencies: [],
        tasks: [a],
      });
    });

    test.each(UNPLAIN_EVENTS)(
      "refuses a write whose events hold %s, before anything copies them, and changes nothing",
      async (_part, unplain) => {
        const target = await store();
        const a = task("a");
        await expect(
          target.commit({ events: [unplain()], putTasks: [a] })
        ).rejects.toThrow(TypeError);

        expect(await target.snapshot()).toEqual({
          dependencies: [],
          tasks: [],
        });
      }
    );

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

    test("takes a write as it stands when commit is called, though the caller changes it at once", async () => {
      const target = await store();
      const kept = task("kept");
      await target.commit({ putTasks: [kept] });
      const write = callerWrite(kept);
      const expected = storedAfter(write, kept);

      const landing = target.commit(write);
      scramble(write, kept);
      await landing;

      expect(normalizeSnapshot(await target.snapshot())).toEqual(
        normalizeSnapshot(expected)
      );
    });

    test.runIf(transactions)(
      "takes a write as it stands when commit is called, though it waits behind a transaction",
      async () => {
        const target = await store();
        const kept = task("kept");
        await target.commit({ putTasks: [kept] });
        const write = callerWrite(kept);
        const expected = storedAfter(write, kept);
        const entered = Promise.withResolvers<void>();
        const held = Promise.withResolvers<void>();
        const running = transactionOf(target)(async () => {
          entered.resolve();
          await held.promise;
        });
        await entered.promise;

        const landing = target.commit(write);
        scramble(write, kept);
        held.resolve();
        await Promise.all([running, landing]);

        expect(normalizeSnapshot(await target.snapshot())).toEqual(
          normalizeSnapshot(expected)
        );
      }
    );

    test.runIf(transactions)(
      "takes a write through a transaction's view as it stands when commit is called",
      async () => {
        const target = await store();
        const kept = task("kept");
        await target.commit({ putTasks: [kept] });
        const write = callerWrite(kept);
        const expected = storedAfter(write, kept);

        await transactionOf(target)(async (view) => {
          const committed = view.commit(write);
          scramble(write, kept);
          await committed;
          expect(normalizeSnapshot(await view.snapshot())).toEqual(
            normalizeSnapshot(expected)
          );
        });

        expect(normalizeSnapshot(await target.snapshot())).toEqual(
          normalizeSnapshot(expected)
        );
      }
    );

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

    test.runIf(transactions)(
      "a transaction reads its own commits and returns what its work returns",
      async () => {
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
      }
    );

    test.runIf(transactions)(
      "a transaction whose work throws leaves nothing, and the next one runs",
      async () => {
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

        await transactionOf(target)((view) =>
          view.commit({ putTasks: [lost] })
        );
        expect(await target.get(lost.id)).toEqual(lost);
      }
    );

    test.runIf(transactions)(
      "a write from outside cannot land between a transaction's read and its commit",
      async () => {
        const target = await store();
        const a = task("a");
        await target.commit({ putTasks: [a] });
        const outside = { ...a, title: "outside" };
        const inside = { ...a, title: "inside" };
        const read = Promise.withResolvers<void>();
        const proceed = Promise.withResolvers<void>();

        const running = transactionOf(target)(async (view) => {
          const before = await view.get(a.id);
          read.resolve();
          await proceed.promise;
          const after = await view.get(a.id);
          await view.commit({ putTasks: [inside] });
          return { after, before };
        });
        await read.promise;
        const landed = target.commit({ putTasks: [outside] });
        await pause(20);
        proceed.resolve();

        expect(await running).toEqual({ after: a, before: a });
        await landed;
        expect(await target.get(a.id)).toEqual(outside);
      }
    );

    test.runIf(transactions && reentrancyGuard)(
      "a call to the store from inside its own transaction is refused at once",
      async () => {
        const target = await store();
        const a = task("a");
        const calls: Record<string, () => Promise<unknown>> = {
          commit: () => target.commit({ putTasks: [a] }),
          get: () => target.get(a.id),
          snapshot: () => target.snapshot(),
          transaction: () => transactionOf(target)(() => Promise.resolve()),
        };
        const { promise: ended, resolve: end } = Promise.withResolvers<void>();
        let later: Promise<unknown> = Promise.resolve();

        const refusals = await transactionOf(target)(async (view) => {
          const outcomes: Record<string, string> = {};
          for (const [method, call] of Object.entries(calls)) {
            outcomes[method] = await settlesWithin(call(), 1000);
          }
          later = ended.then(() => target.commit({ putTasks: [a] }));
          await view.commit({ putTasks: [task("b")] });
          return outcomes;
        });
        end();

        for (const outcome of Object.values(refusals)) {
          expect(outcome).toMatch(REFUSAL);
        }
        await later;
        const ids = (await target.snapshot()).tasks.map((t) => t.id);
        expect(insertionOrder ? ids : [...ids].sort()).toEqual(
          insertionOrder ? ["b", "a"] : ["a", "b"]
        );
      }
    );

    test("optional indexed reads filter by status, parent, and dependency endpoints", async () => {
      const target = await store();
      const root = task("root", { status: "active" });
      const childA = task("child-a", { parentId: root.id, status: "open" });
      const childB = task("child-b", {
        parentId: root.id,
        status: "completed",
      });
      const other = task("other", { status: "open" });
      const edgeA = dependency(childA, root);
      const edgeB = dependency(other, childA);
      await target.commit({
        putDependencies: [edgeA, edgeB],
        putTasks: [root, childA, childB, other],
      });

      if (target.list !== undefined) {
        expect(normalizeTasks(await target.list())).toEqual(
          normalizeTasks([root, childA, childB, other])
        );
        expect(normalizeTasks(await target.list({ status: "open" }))).toEqual(
          normalizeTasks([childA, other])
        );
        expect(normalizeTasks(await target.list({ parentId: null }))).toEqual(
          normalizeTasks([root, other])
        );
        expect(
          normalizeTasks(
            await target.list({ parentId: root.id, status: "completed" })
          )
        ).toEqual([childB]);
      }
      if (target.children !== undefined) {
        expect(normalizeTasks(await target.children(root.id))).toEqual(
          normalizeTasks([childA, childB])
        );
        expect(await target.children(other.id)).toEqual([]);
      }
      if (target.dependenciesOf !== undefined) {
        expect(
          normalizeEdges(await target.dependenciesOf([childA.id]))
        ).toEqual(normalizeEdges([edgeA, edgeB]));
        expect(normalizeEdges(await target.dependenciesOf([root.id]))).toEqual([
          edgeA,
        ]);
        expect(await target.dependenciesOf([])).toEqual([]);
      }
    });
  });
}

const REFUSAL = /refused: .*use the view/;

function pause(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function settlesWithin(
  promise: Promise<unknown>,
  ms: number
): Promise<string> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<string>((resolve) => {
    timer = setTimeout(() => resolve("still pending"), ms);
  });
  try {
    return await Promise.race([
      promise.then(
        () => "resolved",
        (error: unknown) =>
          `refused: ${error instanceof Error ? error.message : String(error)}`
      ),
      timeout,
    ]);
  } finally {
    clearTimeout(timer);
  }
}

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

class ClassEvent {
  readonly at = new Date(0).toISOString();
  readonly dependencies = { added: [], removed: [] };
  readonly id = "event-class";
  readonly tasks = [];
  readonly type = "tasks.changed";
}

const UNPLAIN_EVENTS: readonly (readonly [string, () => TaskEvent])[] = [
  ["a class instance", () => new ClassEvent() as unknown as TaskEvent],
  [
    "a Date",
    () =>
      ({
        at: new Date(0),
        dependencies: { added: [], removed: [] },
        id: "event-date",
        tasks: [],
        type: "tasks.changed",
      }) as unknown as TaskEvent,
  ],
];

function callerWrite(kept: Task) {
  const added = task("added", { metadata: { list: ["x"] }, tags: ["t"] });
  const edge = dependency(added, kept);
  return {
    deleteDependencies: [] as TaskDependency[],
    deleteTasks: [] as TaskId[],
    events: [
      {
        at: added.createdAt,
        dependencies: { added: [{ ...edge }], removed: [] },
        id: "event-added",
        tasks: [{ after: structuredClone(added), before: null, id: added.id }],
        type: "tasks.changed",
      } satisfies TaskEvent,
    ],
    putDependencies: [edge],
    putTasks: [added],
  };
}

function storedAfter(write: ReturnType<typeof callerWrite>, kept: Task) {
  return structuredClone({
    dependencies: write.putDependencies,
    tasks: [kept, ...write.putTasks],
  });
}

function scramble(write: ReturnType<typeof callerWrite>, kept: Task): void {
  for (const put of write.putTasks) {
    mutable(put).title = "changed";
    (put.metadata.list as string[]).push("changed");
    (put.tags as string[]).push("changed");
  }
  for (const edge of write.putDependencies) {
    mutable(edge).dependsOnId = id("changed");
  }
  for (const event of write.events) {
    mutable(event).type = "changed" as "tasks.changed";
  }
  write.putTasks.push(task("late"));
  write.putDependencies.push(dependency(kept, kept));
  write.deleteTasks.push(kept.id);
  write.deleteDependencies.push(...write.putDependencies);
}

function unreadable(): Task["metadata"] {
  return Object.defineProperty({}, "value", {
    enumerable: true,
    get() {
      throw new Error("unreadable metadata");
    },
  });
}

function mutable<T>(value: T | null | undefined): {
  -readonly [K in keyof T]: T[K];
} {
  if (value === null || value === undefined) {
    throw new Error("expected a value");
  }
  return value;
}
