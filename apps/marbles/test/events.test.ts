import { AsyncLocalStorage } from "node:async_hooks";
import { spawn } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join, resolve as resolvePath } from "node:path";
import type { TaskEvent } from "@foundry/tasks";
import { Tasks } from "@foundry/tasks";
import { sql } from "drizzle-orm";
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { DatabaseWorkspaceRecords } from "~/database/tasks";
import type { Engine } from "~/lib/engine";
import { DELIVERY_POLL_MS, Delivery } from "~/lib/events/delivery";
import type { WorkspaceRecords } from "~/lib/events/records";
import { MemoryWorkspaceRecords, PENDING_BATCH } from "~/lib/events/records";
import type { Handler } from "~/lib/events/source";
import { TASKS } from "~/lib/events/source";
import { recordSpawned } from "~/process/spawned";
import { testEngine } from "./helpers/engine";
import type { TestMachine } from "./helpers/records";
import { testMachine } from "./helpers/records";

const CLOSED = /closed/;
const REFUSED = /refused/;

/** Whether `error`, or anything in its causes, has a message matching `pattern`. */
function causedBy(pattern: RegExp): (error: unknown) => boolean {
  return (error) => {
    for (let cause = error; cause instanceof Error; cause = cause.cause) {
      if (pattern.test(cause.message)) {
        return true;
      }
    }
    return false;
  };
}

let machine: TestMachine;
const engines: Engine[] = [];

beforeAll(async () => {
  machine = await testMachine();
});

afterAll(() => {
  machine.close();
});

afterEach(async () => {
  await Promise.all(engines.splice(0).map((engine) => engine.dispose()));
});

/** A workspace's state dir; its rows are scoped by the dir's name. */
function stateDir(): string {
  return machine.workspace();
}

/**
 * An engine over `state`, its tasks in the machine's database (in memory
 * without a state dir), with these observers of tasks.
 */
function engineWith(
  state: string | undefined,
  handlers: readonly Handler<TaskEvent>[],
  print: (line: string) => void = () => undefined
): Engine {
  const engine = testEngine({
    print,
    ...(state ? { records: machine.records(state), state } : {}),
  });
  for (const handler of handlers) {
    engine.observe(TASKS, handler);
  }
  engines.push(engine);
  return engine;
}

/** Stop delivery and give the records up, as a process exit would. */
async function shutDown(engine: Engine): Promise<void> {
  await engine.dispose();
  engines.splice(engines.indexOf(engine), 1);
}

function deliveredCounts(state: string): Promise<number[]> {
  return machine.deliveredCounts(state);
}

async function storedTitles(state: string): Promise<string[]> {
  const records = machine.records(state);
  try {
    return (await records.taskStore.snapshot()).tasks.map((task) => task.title);
  } finally {
    await records.close();
  }
}

function titles(events: readonly TaskEvent[]): string[] {
  return events.flatMap((event) =>
    event.tasks.map((delta) => delta.after?.title ?? `-${delta.id}`)
  );
}

/** `deliver` on every database records, failing the first `fail` calls. */
function losingDeliveries(fail: number): {
  readonly lost: () => number;
  restore(): void;
} {
  const { deliver } = DatabaseWorkspaceRecords.prototype;
  let lost = 0;
  const spy = vi
    .spyOn(DatabaseWorkspaceRecords.prototype, "deliver")
    .mockImplementation(function (
      this: DatabaseWorkspaceRecords,
      id: string,
      hash: string
    ) {
      if (lost < fail) {
        lost += 1;
        return Promise.reject(new Error("the database is gone"));
      }
      return deliver.call(this, id, hash);
    });
  return { lost: () => lost, restore: () => spy.mockRestore() };
}

describe("observing tasks", () => {
  it("delivers each change to every observer; a failure leaves only its own hash absent", async () => {
    const state = stateDir();
    const seen: TaskEvent[] = [];
    let failures = 0;
    const lines: string[] = [];
    const engine = engineWith(
      state,
      [
        (payload) => {
          seen.push(payload);
        },
        () => {
          failures += 1;
          throw new Error("not today");
        },
      ],
      (line) => lines.push(line)
    );
    const tasks = new Tasks({ store: engine.taskStore });
    await engine.start();

    await tasks.create({ tags: ["review"], title: "First" });
    await vi.waitFor(() => expect(failures).toBe(1));
    await engine.stop();

    expect(titles(seen)).toEqual(["First"]);
    expect(seen[0]?.tasks[0]?.after?.tags).toEqual(["review"]);
    const [change] = await machine.changes(state);
    expect(change?.payload).toEqual(seen[0]);
    expect(change?.delivered).toHaveLength(1);
    expect(lines.some((line) => line.includes("not today"))).toBe(true);
  });

  it("hands a failing handler nothing newer until it completes the change it failed on; other observers go on", async () => {
    const state = stateDir();
    const outage: { down: boolean } = { down: true };
    const steady: string[] = [];
    const flaky: string[] = [];
    let failures = 0;
    const engine = engineWith(state, [
      (payload) => {
        steady.push(titles([payload]).join());
      },
      (payload) => {
        const title = titles([payload]).join();
        if (outage.down && title === "First") {
          failures += 1;
          throw new Error("down");
        }
        flaky.push(title);
      },
    ]);
    const tasks = new Tasks({ store: engine.taskStore });
    await engine.start();

    await tasks.create({ title: "First" });
    await vi.waitFor(() => expect(failures).toBe(1));
    // Each change wakes a pass that tries "First" again, and fails.
    await tasks.create({ title: "Second" });
    await vi.waitFor(() => expect(failures).toBe(2));
    await vi.waitFor(async () =>
      expect(await deliveredCounts(state)).toEqual([1, 1])
    );
    expect(steady).toEqual(["First", "Second"]);
    expect(flaky).toEqual([]);

    outage.down = false;
    await tasks.create({ title: "Third" });
    await vi.waitFor(async () =>
      expect(await deliveredCounts(state)).toEqual([2, 2, 2])
    );
    await engine.stop();
    expect(steady).toEqual(["First", "Second", "Third"]);
    expect(flaky).toEqual(["First", "Second", "Third"]);
  });

  it("hands a handler whose completion was not saved that change again before any newer one", async () => {
    const state = stateDir();
    const calls: string[] = [];
    const engine = engineWith(state, [
      (payload) => {
        calls.push(titles([payload]).join());
      },
    ]);
    const losing = losingDeliveries(1);
    try {
      const tasks = new Tasks({ store: engine.taskStore });
      await tasks.create({ title: "First" });
      await tasks.create({ title: "Second" });
      await engine.start();
      await vi.waitFor(() => expect(losing.lost()).toBe(1));
      await tasks.create({ title: "Third" });
      await vi.waitFor(async () =>
        expect(await deliveredCounts(state)).toEqual([1, 1, 1])
      );
      await engine.stop();
    } finally {
      losing.restore();
    }
    // "First" ran twice (at least once), and never after "Second".
    expect(calls).toEqual(["First", "First", "Second", "Third"]);
  });

  it("runs a pass in the context the engine was built in, never in the waking call's", async () => {
    const caller = new AsyncLocalStorage<string>();
    const seen: (string | undefined)[] = [];
    const engine = engineWith(stateDir(), [
      () => {
        seen.push(caller.getStore());
      },
    ]);
    const tasks = new Tasks({ store: engine.taskStore });
    await engine.start();
    // Let the start's own pass, which finds nothing, end; the write below
    // is then what starts the next pass.
    await new Promise((done) => setTimeout(done, 20));
    await caller.run("a command's output", () =>
      tasks.create({ title: "Woken" })
    );
    await vi.waitFor(() => expect(seen).toHaveLength(1));
    await engine.stop();
    expect(seen).toEqual([undefined]);
  });

  it("after a restart, skips handlers whose hash is recorded and redelivers the rest", async () => {
    const state = stateDir();
    const delivered: string[] = [];
    const outage: { down: boolean } = { down: true };
    const steady: Handler<TaskEvent> = (payload) => {
      delivered.push(`steady:${titles([payload]).join()}`);
    };
    const flaky: Handler<TaskEvent> = (payload) => {
      if (outage.down) {
        throw new Error("down");
      }
      delivered.push(`flaky:${titles([payload]).join()}`);
    };

    const first = engineWith(state, [steady, flaky]);
    await first.start();
    await new Tasks({ store: first.taskStore }).create({ title: "Kept" });
    await vi.waitFor(() => expect(delivered).toEqual(["steady:Kept"]));
    await shutDown(first);
    expect(await machine.changes(state)).toHaveLength(1);

    outage.down = false;
    const second = engineWith(state, [steady, flaky]);
    await second.start();
    await vi.waitFor(() =>
      expect(delivered).toEqual(["steady:Kept", "flaky:Kept"])
    );
    await second.stop();
    expect(await deliveredCounts(state)).toEqual([2]);
    expect(await storedTitles(state)).toEqual(["Kept"]);
  });

  it("observers with identical text are told apart by their order, across restarts with fresh functions", async () => {
    const state = stateDir();
    const delivered: string[] = [];
    const outage: { down: boolean } = { down: true };
    // Each call builds a new function with the same source text, as a
    // module re-imported by a new process would.
    const notify =
      (tag: string, flaky: boolean): Handler<TaskEvent> =>
      (payload) => {
        if (flaky && outage.down) {
          throw new Error("down");
        }
        delivered.push(`${tag}:${titles([payload]).join()}`);
      };

    const first = engineWith(state, [notify("a", false), notify("b", true)]);
    await first.start();
    await new Tasks({ store: first.taskStore }).create({ title: "Same" });
    await vi.waitFor(() => expect(delivered).toEqual(["a:Same"]));
    await shutDown(first);
    // Same text, so only their order tells them apart: one hash is recorded.
    expect((await machine.changes(state))[0]?.delivered).toHaveLength(1);

    outage.down = false;
    const second = engineWith(state, [notify("a", false), notify("b", true)]);
    await second.start();
    await vi.waitFor(() => expect(delivered).toEqual(["a:Same", "b:Same"]));
    await second.stop();
    expect(await deliveredCounts(state)).toEqual([2]);
  });

  it("commits a task change and its recorded change together, or neither", async () => {
    const state = stateDir();
    const seen: TaskEvent[] = [];
    const engine = engineWith(state, [
      (payload) => {
        seen.push(payload);
      },
    ]);
    const tasks = new Tasks({ store: engine.taskStore });
    await engine.start();
    await tasks.create({ title: "Before" });
    await vi.waitFor(async () =>
      expect(await deliveredCounts(state)).toEqual([1])
    );
    const { database } = machine.database;
    // The database refuses the change's row: the task must go with it.
    await database.run(
      sql.raw(
        "CREATE TRIGGER refuse_change BEFORE INSERT ON marbles_task_changes WHEN NEW.payload LIKE '%Lost change%' BEGIN SELECT RAISE(ABORT, 'refused'); END"
      )
    );
    // The database refuses the task's row: no change may be recorded.
    await database.run(
      sql.raw(
        "CREATE TRIGGER refuse_task BEFORE INSERT ON tasks WHEN NEW.title = 'Lost task' BEGIN SELECT RAISE(ABORT, 'refused'); END"
      )
    );
    try {
      await expect(tasks.create({ title: "Lost change" })).rejects.toSatisfy(
        causedBy(REFUSED)
      );
      await expect(tasks.create({ title: "Lost task" })).rejects.toSatisfy(
        causedBy(REFUSED)
      );
    } finally {
      await database.run(sql.raw("DROP TRIGGER refuse_change"));
      await database.run(sql.raw("DROP TRIGGER refuse_task"));
    }

    expect(await storedTitles(state)).toEqual(["Before"]);
    expect(await machine.changes(state)).toHaveLength(1);
    await tasks.create({ title: "After" });
    await vi.waitFor(() => expect(titles(seen)).toEqual(["Before", "After"]));
  });

  it("a handler whose completion could not be saved runs again: at least once, not exactly once", async () => {
    const state = stateDir();
    const seen: string[] = [];
    const lines: string[] = [];
    const engine = engineWith(
      state,
      [
        (payload) => {
          seen.push(...titles([payload]));
        },
      ],
      (line) => lines.push(line)
    );
    const losing = losingDeliveries(1);
    try {
      const tasks = new Tasks({ store: engine.taskStore });
      await engine.start();
      await tasks.create({ title: "Once" });
      await vi.waitFor(() =>
        expect(lines.some((line) => line.includes("may run again"))).toBe(true)
      );
      await tasks.create({ title: "Twice" });
      await vi.waitFor(async () =>
        expect(await deliveredCounts(state)).toEqual([1, 1])
      );
    } finally {
      losing.restore();
    }
    expect(seen).toEqual(["Once", "Once", "Twice"]);
  });

  it("delivered hashes and task commits that race all survive", async () => {
    const state = stateDir();
    const records = machine.records(state);
    const tasks = new Tasks({ store: records.taskStore });
    await tasks.create({ title: "Shared" });
    const [item] = await records.pending({ handlers: ["a", "b"] });
    if (item === undefined) {
      throw new Error("no change recorded");
    }

    await Promise.all([
      records.deliver(item.id, "a"),
      tasks.create({ title: "During" }),
      records.deliver(item.id, "b"),
      records.deliver(item.id, "a"),
    ]);
    await records.close();

    const reopened = machine.records(state);
    const items = await machine.changes(state);
    expect(
      items.find((entry) => entry.id === item.id)?.delivered.toSorted()
    ).toEqual(["a", "b"]);
    expect(items).toHaveLength(2);
    const snapshot = await reopened.taskStore.snapshot();
    expect(snapshot.tasks.map((task) => task.title).sort()).toEqual([
      "During",
      "Shared",
    ]);
    await reopened.close();
  });

  it("refuses a __proto__ metadata key before it is stored", async () => {
    const state = stateDir();
    const records = machine.records(state);
    const tasks = new Tasks({ store: records.taskStore });
    // A quoted `__proto__` in an object literal sets the prototype; parsed
    // JSON defines the key.
    const proto = JSON.parse(
      '{"__proto__":{"owner":"alice"},"nested":{"__proto__":{"ok":1}}}'
    );
    const PROTO = '"__proto__" is not allowed as a metadata key';
    await expect(
      tasks.create({ metadata: proto, title: "No" })
    ).rejects.toThrow(PROTO);
    const task = await tasks.create({
      metadata: { nested: { owner: "alice" } },
      title: "Kept",
    });
    await expect(tasks.update(task.id, { metadata: proto })).rejects.toThrow(
      PROTO
    );
    await records.close();

    const reopened = machine.records(state);
    const [kept] = (await reopened.taskStore.snapshot()).tasks;
    expect(kept?.metadata).toEqual({ nested: { owner: "alice" } });
    const items = await reopened.pending({ handlers: ["new"] });
    expect(items).toHaveLength(1);
    expect(JSON.stringify(items[0]?.payload)).toContain(
      '"metadata":{"nested":{"owner":"alice"}}'
    );
    await reopened.close();
  });

  it("a handler can change tasks without a deadlock, and that change is delivered too", async () => {
    for (const state of [undefined, stateDir()]) {
      const seen: TaskEvent[] = [];
      let follow: Tasks | undefined;
      const engine = engineWith(state, [
        async (payload) => {
          seen.push(payload);
          const created = payload.tasks.find(
            (delta) =>
              delta.before === null && delta.after?.tags.includes("review")
          );
          if (created !== undefined) {
            await follow?.create({ title: `Review ${created.after?.title}` });
          }
        },
      ]);
      follow = new Tasks({ store: engine.taskStore });
      await engine.start();

      await follow.create({ tags: ["review"], title: "API" });
      await vi.waitFor(() =>
        expect(titles(seen)).toEqual(["API", "Review API"])
      );
    }
  });

  it("remove, edge-only, and no-op changes reach observers as they committed", async () => {
    const seen: TaskEvent[] = [];
    const engine = engineWith(undefined, [
      (payload) => {
        seen.push(payload);
      },
    ]);
    const tasks = new Tasks({ store: engine.taskStore });
    await engine.start();
    const a = await tasks.create({ title: "A" });
    const b = await tasks.create({ title: "B" });
    await tasks.change({
      operations: [
        { dependsOn: { id: b.id }, kind: "dependency.add", task: { id: a.id } },
      ],
    });
    await tasks.change({
      operations: [
        { kind: "task.set_status", status: "open", task: { id: a.id } },
      ],
    });
    await tasks.remove(a.id);
    await vi.waitFor(() => expect(seen).toHaveLength(4));
    await engine.stop();

    const [, , edge, removal] = seen;
    expect(edge?.tasks).toEqual([]);
    expect(edge?.dependencies.added).toEqual([
      { dependsOnId: b.id, taskId: a.id },
    ]);
    expect(removal?.tasks).toEqual([{ after: null, before: a, id: a.id }]);
    expect(removal?.dependencies.removed).toEqual([
      { dependsOnId: b.id, taskId: a.id },
    ]);
  });

  it("keeps each workspace's tasks and deliveries apart", async () => {
    const seenA: TaskEvent[] = [];
    const seenB: TaskEvent[] = [];
    const [stateA, stateB] = [stateDir(), stateDir()];
    const a = engineWith(stateA, [
      (payload) => {
        seenA.push(payload);
      },
    ]);
    const b = engineWith(stateB, [
      (payload) => {
        seenB.push(payload);
      },
    ]);
    await Promise.all([a.start(), b.start()]);

    await new Tasks({ store: a.taskStore }).create({ title: "Only A" });
    await new Tasks({ store: b.taskStore }).create({ title: "Only B" });
    await vi.waitFor(() => {
      expect(titles(seenA)).toEqual(["Only A"]);
      expect(titles(seenB)).toEqual(["Only B"]);
    });
    expect(
      (await b.taskStore.snapshot()).tasks.map((task) => task.title)
    ).toEqual(["Only B"]);
    expect(await storedTitles(stateA)).toEqual(["Only A"]);
    expect(
      (await machine.changes(stateB)).map((c) => titles([c.payload]))
    ).toEqual([["Only B"]]);
  });

  it("ignores a tasks.json an earlier Marbles left, and leaves it as it is", async () => {
    const state = stateDir();
    const path = join(state, "tasks.json");
    const old = JSON.stringify({
      dependencies: [],
      items: [],
      tasks: [{ id: "tk-old", title: "From the file" }],
      version: 1,
    });
    writeFileSync(path, old);

    const engine = engineWith(state, [() => undefined]);
    await engine.start();
    const tasks = new Tasks({ store: engine.taskStore });
    expect((await tasks.list()).items).toEqual([]);
    await tasks.create({ title: "New" });
    expect(await storedTitles(state)).toEqual(["New"]);
    expect(readFileSync(path, "utf8")).toBe(old);
  });

  it("keeps a change made with no observer, for an observer declared after a restart", async () => {
    const state = stateDir();
    const unobserved = engineWith(state, []);
    await unobserved.start();
    await new Tasks({ store: unobserved.taskStore }).create({ title: "Quiet" });
    expect(await deliveredCounts(state)).toEqual([0]);
    await shutDown(unobserved);

    const seen: TaskEvent[] = [];
    const observed = engineWith(state, [
      (payload) => {
        seen.push(payload);
      },
    ]);
    await observed.start();
    await vi.waitFor(() => expect(titles(seen)).toEqual(["Quiet"]));
    await observed.stop();
    expect(await deliveredCounts(state)).toEqual([1]);
  });

  it("keeps a completed change and every hash, and never hands it to a handler that completed it", async () => {
    const state = stateDir();
    const calls: string[] = [];
    const first: Handler<TaskEvent> = (payload) => {
      calls.push(`first:${titles([payload]).join()}`);
    };
    const second: Handler<TaskEvent> = (payload) => {
      calls.push(`second:${titles([payload]).join()}`);
    };
    const engine = engineWith(state, [first, second]);
    await engine.start();
    await new Tasks({ store: engine.taskStore }).create({ title: "Done" });
    await vi.waitFor(async () =>
      expect(await deliveredCounts(state)).toEqual([2])
    );
    const [item] = await machine.changes(state);
    expect(new Set(item?.delivered).size).toBe(2);
    await shutDown(engine);

    // Restarted twice over the same records: nothing is handed over again.
    for (const _ of [1, 2]) {
      const again = engineWith(state, [first, second]);
      await again.start();
      await again.stop();
      await shutDown(again);
    }
    expect(calls).toEqual(["first:Done", "second:Done"]);
    expect(await machine.changes(state)).toEqual([item]);
  });

  it("keeps a failing observer's pending change while it is not declared, and delivers it when it is again", async () => {
    const state = stateDir();
    const calls: string[] = [];
    const outage: { down: boolean } = { down: true };
    const steady: Handler<TaskEvent> = (payload) => {
      calls.push(`steady:${titles([payload]).join()}`);
    };
    const flaky: Handler<TaskEvent> = (payload) => {
      if (outage.down) {
        throw new Error("down");
      }
      calls.push(`flaky:${titles([payload]).join()}`);
    };

    const both = engineWith(state, [steady, flaky]);
    await both.start();
    await new Tasks({ store: both.taskStore }).create({ title: "Pending" });
    await vi.waitFor(async () =>
      expect(await deliveredCounts(state)).toEqual([1])
    );
    await shutDown(both);

    const without = engineWith(state, [steady]);
    await without.start();
    await without.stop();
    await shutDown(without);
    expect(await deliveredCounts(state)).toEqual([1]);

    outage.down = false;
    const restored = engineWith(state, [steady, flaky]);
    await restored.start();
    await vi.waitFor(() =>
      expect(calls).toEqual(["steady:Pending", "flaky:Pending"])
    );
    await restored.stop();
    expect(await deliveredCounts(state)).toEqual([2]);
  });

  it("removal asks inUse outside the records' turn, so it may write through another Tasks", async () => {
    const state = stateDir();
    const records = machine.records(state);
    const writer = new Tasks({ store: records.taskStore });
    const other = await writer.create({ title: "Other" });
    const guarded = new Tasks({
      inUse: async () => {
        await writer.update(other.id, { title: "Checked" });
        return false;
      },
      store: records.taskStore,
    });
    const target = await guarded.create({ title: "Target" });

    await guarded.remove(target.id);
    await writer.update(other.id, { title: "Later" });
    await records.close();

    const reopened = machine.records(state);
    const { tasks } = await reopened.taskStore.snapshot();
    expect(tasks.map((task) => task.title)).toEqual(["Later"]);
    const payloads = (await reopened.pending({ handlers: ["new"] })).map(
      (item) => item.payload as TaskEvent
    );
    expect(
      payloads.map((event) => event.tasks[0]?.after?.title ?? "-")
    ).toEqual(["Other", "Target", "Checked", "-", "Later"]);
    await reopened.close();
  });
});

describe("delivery lifecycle", () => {
  it("delivers nothing before a successful start", async () => {
    const seen: TaskEvent[] = [];
    const engine = engineWith(undefined, [
      (payload) => {
        seen.push(payload);
      },
    ]);
    await new Tasks({ store: engine.taskStore }).create({ title: "Early" });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(seen).toEqual([]);

    await engine.start();
    await vi.waitFor(() => expect(titles(seen)).toEqual(["Early"]));
  });

  it("lets several engines over one workspace read and write its tasks, and refuses them to a disposed one", async () => {
    const state = stateDir();
    const first = engineWith(state, []);
    const second = engineWith(state, []);
    await new Tasks({ store: first.taskStore }).create({ title: "From first" });
    await new Tasks({ store: second.taskStore }).create({
      title: "From second",
    });
    expect(
      (await first.taskStore.snapshot()).tasks.map((task) => task.title)
    ).toEqual(["From first", "From second"]);

    await shutDown(first);
    await expect(first.taskStore.snapshot()).rejects.toThrow(CLOSED);
    expect((await second.taskStore.snapshot()).tasks).toHaveLength(2);
  });

  it("stopping waits for the running handler before delivery is given up", async () => {
    const state = stateDir();
    let release: () => void = () => undefined;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    let entered = false;
    let finished = false;
    const slow: Handler<TaskEvent> = async () => {
      entered = true;
      await blocked;
      finished = true;
    };
    const first = engineWith(state, [slow]);
    await first.start();
    await new Tasks({ store: first.taskStore }).create({ title: "Slow" });
    await vi.waitFor(() => expect(entered).toBe(true));

    let disposed = false;
    const disposing = first.dispose().then(() => {
      disposed = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(disposed).toBe(false);
    const lines: string[] = [];
    const second = engineWith(state, [() => undefined], (line) =>
      lines.push(line)
    );
    await second.start();
    expect(
      lines.some((line) => line.startsWith("[observe] not delivering"))
    ).toBe(true);

    release();
    await disposing;
    engines.splice(engines.indexOf(first), 1);
    expect(finished).toBe(true);
    // The handler completed before the stop, so its hash was saved.
    expect(await deliveredCounts(state)).toEqual([1]);
    // Delivery is free again, and the completed change is not handed over.
    const after: TaskEvent[] = [];
    const third = engineWith(state, [
      slow,
      (payload) => {
        after.push(payload);
      },
    ]);
    await third.start();
    await vi.waitFor(() => expect(titles(after)).toEqual(["Slow"]));
  });

  it("a process that does not deliver still starts, and leaves delivery to the one that does", async () => {
    const state = stateDir();
    const owner = engineWith(state, [() => undefined]);
    await owner.start();
    const lines: string[] = [];
    const other = engineWith(state, [() => undefined], (line) =>
      lines.push(line)
    );
    await other.start();
    expect(
      lines.some((line) => line.startsWith("[observe] not delivering"))
    ).toBe(true);
    await new Tasks({ store: other.taskStore }).create({ title: "Written" });
    expect(await storedTitles(state)).toEqual(["Written"]);
    expect(existsSync(join(state, "tasks.json"))).toBe(false);
  });
});

describe("delivery across processes", () => {
  it("delivers a change recorded through other records without any change made here", async () => {
    const state = stateDir();
    const seen: TaskEvent[] = [];
    const owner = engineWith(state, [
      (payload) => {
        seen.push(payload);
      },
    ]);
    await owner.start();
    // Let the start's own pass end, so only noticing the change can deliver it.
    await new Promise((settle) => setTimeout(settle, 200));
    // Another process's records, on the same workspace in the same database.
    const elsewhere = machine.records(state);
    try {
      await new Tasks({ store: elsewhere.taskStore }).create({
        title: "From elsewhere",
      });
      await vi.waitFor(() => expect(titles(seen)).toEqual(["From elsewhere"]), {
        timeout: DELIVERY_POLL_MS * 5,
      });
    } finally {
      await elsewhere.close();
    }
  });

  it("takes delivery over once the deliverer stops, and delivers what was written meanwhile", async () => {
    const state = stateDir();
    const first = engineWith(state, [() => undefined]);
    await first.start();
    const seen: TaskEvent[] = [];
    const lines: string[] = [];
    const survivor = engineWith(
      state,
      [
        (payload) => {
          seen.push(payload);
        },
      ],
      (line) => lines.push(line)
    );
    await survivor.start();
    expect(lines.some((line) => line.includes("not delivering here"))).toBe(
      true
    );
    await shutDown(first);
    await new Tasks({ store: survivor.taskStore }).create({ title: "Later" });
    await vi.waitFor(() => expect(titles(seen)).toEqual(["Later"]), {
      timeout: DELIVERY_POLL_MS * 5,
    });
  });

  it("takes delivery over from a process that exited holding it", async () => {
    const state = stateDir();
    const script = join(state, "holder.ts");
    writeFileSync(
      script,
      `import { openDatabase } from ${JSON.stringify(resolvePath("src/database/open.ts"))};
import { DatabaseWorkspaceRecords } from ${JSON.stringify(resolvePath("src/database/tasks.ts"))};
const opened = await openDatabase(${JSON.stringify(machine.database.file)});
if (opened === undefined) throw new Error("no database");
const records = new DatabaseWorkspaceRecords({ database: opened.database, scope: ${JSON.stringify(basename(state))} });
if ((await records.claimDelivery()) !== undefined) throw new Error("not claimed");
process.stdout.write("held\\n");
setInterval(() => undefined, 1000);
`
    );
    const holder = spawn("bun", [script], { cwd: resolvePath(".") });
    recordSpawned(holder.pid, false);
    await new Promise<void>((ready, failed) => {
      holder.stdout?.on("data", (chunk: Buffer) => {
        if (chunk.toString().includes("held")) {
          ready();
        }
      });
      holder.once("exit", (code) => failed(new Error(`exited ${code}`)));
    });
    const seen: TaskEvent[] = [];
    const survivor = engineWith(state, [
      (payload) => {
        seen.push(payload);
      },
    ]);
    try {
      await survivor.start();
      await new Tasks({ store: survivor.taskStore }).create({
        title: "Waiting",
      });
      await new Promise((settle) => setTimeout(settle, DELIVERY_POLL_MS * 2));
      expect(seen).toEqual([]);
    } finally {
      holder.kill("SIGKILL");
    }
    await new Promise((settle) => holder.once("exit", settle));
    await vi.waitFor(() => expect(titles(seen)).toEqual(["Waiting"]), {
      timeout: DELIVERY_POLL_MS * 5,
    });
  });
});

describe("the work of a pass", () => {
  it("reads from the first change an observer has not completed, not from the start of the history", async () => {
    const memory = new MemoryWorkspaceRecords();
    const reads: number[] = [];
    const records: WorkspaceRecords = {
      claimDelivery: () => memory.claimDelivery(),
      close: () => memory.close(),
      deliver: (id, hash) => memory.deliver(id, hash),
      latest: () => memory.latest(),
      pending: (query) => {
        reads.push(query.after ?? 0);
        return memory.pending(query);
      },
      releaseDelivery: () => memory.releaseDelivery(),
      taskStore: memory.taskStore,
      watch: (listener) => memory.watch(listener),
    };
    let delivered = 0;
    const engine = testEngine({ print: () => undefined, records });
    engines.push(engine);
    engine.observe(TASKS, () => {
      delivered += 1;
    });
    const tasks = new Tasks({ store: engine.taskStore });
    const history = PENDING_BATCH * 2 + 50;
    for (let index = 0; index < history; index += 1) {
      await tasks.create({ title: `T${String(index)}` });
    }
    await engine.start();
    await vi.waitFor(() => expect(delivered).toBe(history));
    reads.length = 0;
    await tasks.create({ title: "One more" });
    await vi.waitFor(() => expect(delivered).toBe(history + 1));
    expect(reads.length).toBeGreaterThan(0);
    expect(Math.min(...reads)).toBeGreaterThanOrEqual(history);
  });
});

describe("the delivery timer", () => {
  it("does not keep a process alive", async () => {
    const dir = stateDir();
    const script = join(dir, "never-stopped.ts");
    writeFileSync(
      script,
      `import { Delivery } from ${JSON.stringify(resolvePath("src/lib/events/delivery.ts"))};
import { MemoryWorkspaceRecords } from ${JSON.stringify(resolvePath("src/lib/events/records.ts"))};
import { TASKS } from ${JSON.stringify(resolvePath("src/lib/events/source.ts"))};
const delivery = new Delivery({ print: () => undefined, records: new MemoryWorkspaceRecords() });
delivery.observe(TASKS, () => undefined);
await delivery.start();
process.stdout.write("started\\n");
`
    );
    const started = Date.now();
    const child = spawn("bun", [script], { cwd: resolvePath(".") });
    recordSpawned(child.pid, false);
    let output = "";
    child.stdout?.on("data", (chunk: Buffer) => {
      output += chunk.toString();
    });
    // A process the timer keeps alive is killed, and fails the exit check.
    const deadline = setTimeout(
      () => child.kill("SIGKILL"),
      DELIVERY_POLL_MS * 10
    );
    const code = await new Promise((settle) => child.once("exit", settle));
    clearTimeout(deadline);
    expect(output).toContain("started");
    expect(code).toBe(0);
    expect(Date.now() - started).toBeLessThan(DELIVERY_POLL_MS * 10);
  });

  it("gives up a claim granted after it was stopped, and never starts delivering", async () => {
    const memory = new MemoryWorkspaceRecords();
    const { promise: granted, resolve: grant } = Promise.withResolvers<
      string | undefined
    >();
    let released = 0;
    let reads = 0;
    const records: WorkspaceRecords = {
      claimDelivery: () => granted,
      close: () => memory.close(),
      deliver: (id, hash) => memory.deliver(id, hash),
      latest: () => {
        reads += 1;
        return memory.latest();
      },
      pending: (query) => memory.pending(query),
      releaseDelivery: () => {
        released += 1;
        return Promise.resolve();
      },
      taskStore: memory.taskStore,
      watch: (listener) => memory.watch(listener),
    };
    const delivery = new Delivery({ print: () => undefined, records });
    delivery.observe(TASKS, () => undefined);
    const starting = delivery.start();
    await delivery.stop();
    grant(undefined);
    await starting;
    expect(released).toBe(1);
    await new Promise((settle) => setTimeout(settle, DELIVERY_POLL_MS * 2));
    expect(reads).toBe(0);
  });

  it("never runs once stopped while its start was still reading, and gives the claim up", async () => {
    const memory = new MemoryWorkspaceRecords();
    const { promise: read, resolve: answer } = Promise.withResolvers<number>();
    let reading: (() => void) | undefined;
    const entered = new Promise<void>((resolve) => {
      reading = resolve;
    });
    let released = 0;
    let passes = 0;
    const records: WorkspaceRecords = {
      claimDelivery: () => memory.claimDelivery(),
      close: () => memory.close(),
      deliver: (id, hash) => memory.deliver(id, hash),
      latest: () => {
        reading?.();
        return read;
      },
      pending: (query) => {
        passes += 1;
        return memory.pending(query);
      },
      releaseDelivery: () => {
        released += 1;
        return Promise.resolve();
      },
      taskStore: memory.taskStore,
      watch: (listener) => memory.watch(listener),
    };
    const delivery = new Delivery({ print: () => undefined, records });
    delivery.observe(TASKS, () => undefined);
    const starting = delivery.start();
    await entered;
    await delivery.stop();
    expect(released).toBe(1);
    answer(1);
    await starting;
    delivery.wake();
    await new Promise((settle) => setTimeout(settle, DELIVERY_POLL_MS * 2));
    expect(passes).toBe(0);
    expect(released).toBe(1);
  });

  it("reads nothing once delivery has stopped", async () => {
    const memory = new MemoryWorkspaceRecords();
    let reads = 0;
    const records: WorkspaceRecords = {
      claimDelivery: () => memory.claimDelivery(),
      close: () => memory.close(),
      deliver: (id, hash) => memory.deliver(id, hash),
      latest: () => {
        reads += 1;
        return memory.latest();
      },
      pending: (query) => memory.pending(query),
      releaseDelivery: () => memory.releaseDelivery(),
      taskStore: memory.taskStore,
      watch: (listener) => memory.watch(listener),
    };
    const engine = testEngine({ print: () => undefined, records });
    engines.push(engine);
    engine.observe(TASKS, () => undefined);
    await engine.start();
    // Running, it polls.
    await vi.waitFor(() => expect(reads).toBeGreaterThan(1), {
      timeout: DELIVERY_POLL_MS * 5,
    });
    await engine.stop();
    const after = reads;
    await new Promise((settle) => setTimeout(settle, DELIVERY_POLL_MS * 3));
    expect(reads).toBe(after);
  });
});
