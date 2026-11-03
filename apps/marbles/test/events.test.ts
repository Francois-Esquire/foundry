import { AsyncLocalStorage } from "node:async_hooks";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TaskEvent } from "@foundry/tasks";
import { Tasks } from "@foundry/tasks";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Engine } from "~/lib/engine";
import { WorkspaceRecords } from "~/lib/events/records";
import type { Handler } from "~/lib/events/source";
import { TASKS } from "~/lib/events/source";
import { testEngine } from "./helpers/engine";

const IN_USE = /in use by/;
const NOT_RECORDS = /does not hold Marbles task records/;
const CLOSED = /closed/;

interface StoredItem {
  readonly delivered: readonly string[];
  readonly id: string;
  readonly payload: TaskEvent;
  readonly source: string;
}

interface StoredRecords {
  readonly items: readonly StoredItem[];
  readonly tasks: readonly { readonly id: string; readonly title: string }[];
  readonly version: number;
}

const engines: Engine[] = [];

afterEach(async () => {
  await Promise.all(engines.splice(0).map((engine) => engine.dispose()));
});

function stateDir(): string {
  return mkdtempSync(join(tmpdir(), "marbles-events-"));
}

/** An engine over `state` (memory without one) with these observers of tasks. */
function engineWith(
  state: string | undefined,
  handlers: readonly Handler<TaskEvent>[],
  print: (line: string) => void = () => undefined
): Engine {
  const engine = testEngine({ print, ...(state ? { state } : {}) });
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

function stored(state: string): StoredRecords {
  return JSON.parse(readFileSync(join(state, "tasks.json"), "utf8"));
}

/** How many handlers completed each stored item, oldest first. */
function deliveredCounts(state: string): number[] {
  return stored(state).items.map((item) => item.delivered.length);
}

function titles(events: readonly TaskEvent[]): string[] {
  return events.flatMap((event) =>
    event.tasks.map((delta) => delta.after?.title ?? `-${delta.id}`)
  );
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
    const [item] = stored(state).items;
    expect(item?.source).toBe("tasks");
    expect(item?.delivered).toHaveLength(1);
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
    await vi.waitFor(() => expect(deliveredCounts(state)).toEqual([1, 1]));
    expect(steady).toEqual(["First", "Second"]);
    expect(flaky).toEqual([]);

    outage.down = false;
    await tasks.create({ title: "Third" });
    await vi.waitFor(() => expect(deliveredCounts(state)).toEqual([2, 2, 2]));
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
    const { deliver } = WorkspaceRecords.prototype;
    let lost = 0;
    const spy = vi
      .spyOn(WorkspaceRecords.prototype, "deliver")
      .mockImplementation(function (this: WorkspaceRecords, id, hash) {
        if (lost === 0) {
          lost += 1;
          return Promise.reject(new Error("the disk is full"));
        }
        return deliver.call(this, id, hash);
      });
    try {
      const tasks = new Tasks({ store: engine.taskStore });
      // Both are stored before the start's pass reads them.
      await tasks.create({ title: "First" });
      await tasks.create({ title: "Second" });
      await engine.start();
      await vi.waitFor(() => expect(lost).toBe(1));
      await tasks.create({ title: "Third" });
      await vi.waitFor(() => expect(deliveredCounts(state)).toEqual([1, 1, 1]));
      await engine.stop();
    } finally {
      spy.mockRestore();
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
    // The start's own pass has no items and does no I/O; once it is over,
    // the write below is what starts the next pass.
    await new Promise((done) => setTimeout(done, 0));
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
    expect(stored(state).items).toHaveLength(1);

    outage.down = false;
    const second = engineWith(state, [steady, flaky]);
    await second.start();
    await vi.waitFor(() =>
      expect(delivered).toEqual(["steady:Kept", "flaky:Kept"])
    );
    await second.stop();
    // Both completed it: the item stays, with both hashes.
    expect(deliveredCounts(state)).toEqual([2]);
    expect(stored(state).tasks.map((task) => task.title)).toEqual(["Kept"]);
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
    expect(stored(state).items[0]?.delivered).toHaveLength(1);

    outage.down = false;
    const second = engineWith(state, [notify("a", false), notify("b", true)]);
    await second.start();
    await vi.waitFor(() => expect(delivered).toEqual(["a:Same", "b:Same"]));
    await second.stop();
    expect(deliveredCounts(state)).toEqual([2]);
  });

  it("a failed write publishes neither the task nor its item", async () => {
    if (process.getuid?.() === 0) {
      return;
    }
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
    // Delivered and its hash saved, so the failure below is the task's alone.
    await vi.waitFor(() => expect(deliveredCounts(state)).toEqual([1]));
    expect(titles(seen)).toEqual(["Before"]);
    const before = readFileSync(join(state, "tasks.json"), "utf8");

    chmodSync(state, 0o500);
    try {
      await expect(tasks.create({ title: "Lost" })).rejects.toThrow();
    } finally {
      chmodSync(state, 0o700);
    }

    expect((await tasks.list()).items.map((task) => task.title)).toEqual([
      "Before",
    ]);
    expect(readFileSync(join(state, "tasks.json"), "utf8")).toBe(before);
    await tasks.create({ title: "After" });
    await vi.waitFor(() => expect(titles(seen)).toEqual(["Before", "After"]));
  });

  it("a handler whose completion could not be saved runs again: at least once, not exactly once", async () => {
    if (process.getuid?.() === 0) {
      return;
    }
    const state = stateDir();
    const seen: string[] = [];
    let release: () => void = () => undefined;
    let gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const lines: string[] = [];
    const engine = engineWith(
      state,
      [
        async (payload) => {
          await gate;
          seen.push(...titles([payload]));
        },
      ],
      (line) => lines.push(line)
    );
    const tasks = new Tasks({ store: engine.taskStore });
    await engine.start();
    await tasks.create({ title: "Once" });

    chmodSync(state, 0o500);
    try {
      release();
      await vi.waitFor(() =>
        expect(lines.some((line) => line.includes("may run again"))).toBe(true)
      );
    } finally {
      chmodSync(state, 0o700);
    }
    gate = Promise.resolve();
    await tasks.create({ title: "Twice" });
    await vi.waitFor(() => expect(deliveredCounts(state)).toEqual([1, 1]));
    expect(seen).toEqual(["Once", "Once", "Twice"]);
  });

  it("delivered hashes and task commits that race all survive", async () => {
    const state = stateDir();
    const records = new WorkspaceRecords({ dir: state });
    const tasks = new Tasks({ store: records.taskStore });
    await tasks.create({ title: "Shared" });
    const [item] = await records.pending();
    if (item === undefined) {
      throw new Error("no item emitted");
    }

    await Promise.all([
      records.deliver(item.id, "a"),
      tasks.create({ title: "During" }),
      records.deliver(item.id, "b"),
      records.deliver(item.id, "a"),
    ]);
    await records.close();

    const reopened = new WorkspaceRecords({ dir: state });
    const items = await reopened.pending();
    expect(items.find((entry) => entry.id === item.id)?.delivered).toEqual([
      "a",
      "b",
    ]);
    expect(items).toHaveLength(2);
    const snapshot = await reopened.taskStore.snapshot();
    expect(snapshot.tasks.map((task) => task.title).sort()).toEqual([
      "During",
      "Shared",
    ]);
    await reopened.close();
  });

  it("a handler can change tasks without a deadlock, and that change is delivered too", async () => {
    const seen: TaskEvent[] = [];
    let follow: Tasks | undefined;
    const engine = engineWith(undefined, [
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
    await vi.waitFor(() => expect(titles(seen)).toEqual(["API", "Review API"]));
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
    // Nothing changes: no item.
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

  it("restores the source by its key and keeps items from a source it does not define", async () => {
    const state = stateDir();
    const first = engineWith(state, [
      () => {
        throw new Error("later");
      },
    ]);
    await new Tasks({ store: first.taskStore }).create({ title: "Pending" });
    await shutDown(first);
    const written = stored(state);
    const foreign = {
      delivered: [],
      id: "elsewhere",
      payload: { kind: "other.changed" },
      source: "other",
    };
    writeFileSync(
      join(state, "tasks.json"),
      JSON.stringify({ ...written, items: [...written.items, foreign] })
    );

    const seen: TaskEvent[] = [];
    const second = engineWith(state, [
      (payload) => {
        seen.push(payload);
      },
    ]);
    await second.start();
    await vi.waitFor(() => expect(titles(seen)).toEqual(["Pending"]));
    await second.stop();
    const [restored, kept] = stored(state).items;
    expect(restored?.source).toBe("tasks");
    expect(restored?.delivered).toHaveLength(1);
    expect(kept).toEqual(foreign);
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
  });

  it("refuses records it cannot read, and leaves them as they are", async () => {
    const state = stateDir();
    const path = join(state, "tasks.json");
    const garbage = '{"version": 1, "tasks": [';
    writeFileSync(path, garbage);

    const observed = engineWith(state, [() => undefined]);
    await expect(observed.start()).rejects.toThrow(NOT_RECORDS);
    const plain = engineWith(state, []);
    await expect(plain.taskStore.snapshot()).rejects.toThrow(NOT_RECORDS);
    writeFileSync(path, JSON.stringify({ items: [], version: 1 }));
    await expect(plain.taskStore.snapshot()).rejects.toThrow(NOT_RECORDS);
    writeFileSync(path, garbage);
    await expect(
      new Tasks({ store: plain.taskStore }).create({ title: "No" })
    ).rejects.toThrow(NOT_RECORDS);
    expect(readFileSync(path, "utf8")).toBe(garbage);
  });

  it("keeps a change made with no observer, for an observer declared after a restart", async () => {
    const state = stateDir();
    const unobserved = engineWith(state, []);
    await unobserved.start();
    await new Tasks({ store: unobserved.taskStore }).create({ title: "Quiet" });
    expect(deliveredCounts(state)).toEqual([0]);
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
    expect(deliveredCounts(state)).toEqual([1]);
  });

  it("keeps a completed item and every hash, and never hands it to a handler that completed it", async () => {
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
    await vi.waitFor(() => expect(deliveredCounts(state)).toEqual([2]));
    const [item] = stored(state).items;
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
    expect(stored(state).items).toEqual([item]);
  });

  it("keeps a failing observer's pending item while it is not declared, and delivers it when it is again", async () => {
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
    await vi.waitFor(() => expect(deliveredCounts(state)).toEqual([1]));
    await shutDown(both);

    // The failing observer is removed from the source for a while.
    const without = engineWith(state, [steady]);
    await without.start();
    await without.stop();
    await shutDown(without);
    expect(deliveredCounts(state)).toEqual([1]);

    outage.down = false;
    const restored = engineWith(state, [steady, flaky]);
    await restored.start();
    await vi.waitFor(() =>
      expect(calls).toEqual(["steady:Pending", "flaky:Pending"])
    );
    await restored.stop();
    expect(deliveredCounts(state)).toEqual([2]);
  });

  it("removal asks inUse outside the records' turn, so it may write through another Tasks", async () => {
    const state = stateDir();
    const records = new WorkspaceRecords({ dir: state });
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

    const reopened = new WorkspaceRecords({ dir: state });
    const { tasks } = await reopened.taskStore.snapshot();
    expect(tasks.map((task) => task.title)).toEqual(["Later"]);
    // Create, create, update, remove, update: every change emitted, in order.
    const payloads = (await reopened.pending()).map(
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

  it("one engine owns a state dir's records until it is disposed", async () => {
    const state = stateDir();
    const first = engineWith(state, []);
    await first.taskStore.snapshot();
    const second = engineWith(state, []);
    await expect(second.taskStore.snapshot()).rejects.toThrow(IN_USE);

    await shutDown(first);
    await expect(first.taskStore.snapshot()).rejects.toThrow(CLOSED);
    expect((await second.taskStore.snapshot()).tasks).toEqual([]);
  });

  it("stopping waits for the running handler before ownership is given up", async () => {
    const state = stateDir();
    let release: () => void = () => undefined;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    let entered = false;
    let finished = false;
    const first = engineWith(state, [
      async () => {
        entered = true;
        await blocked;
        finished = true;
      },
    ]);
    await first.start();
    await new Tasks({ store: first.taskStore }).create({ title: "Slow" });
    await vi.waitFor(() => expect(entered).toBe(true));

    let disposed = false;
    const disposing = first.dispose().then(() => {
      disposed = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(disposed).toBe(false);
    const second = engineWith(state, []);
    await expect(second.taskStore.snapshot()).rejects.toThrow(IN_USE);

    release();
    await disposing;
    engines.splice(engines.indexOf(first), 1);
    expect(finished).toBe(true);
    // The handler completed before the stop, so its hash was saved.
    expect(deliveredCounts(state)).toEqual([1]);
    expect((await second.taskStore.snapshot()).tasks).toHaveLength(1);
  });

  it("a process that does not own the records still starts, and leaves delivery to the owner", async () => {
    const state = stateDir();
    mkdirSync(state, { recursive: true });
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
    expect(existsSync(join(state, "tasks.json"))).toBe(false);
  });
});
