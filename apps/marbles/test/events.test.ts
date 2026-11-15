import { AsyncLocalStorage } from "node:async_hooks";
import { spawn } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
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
import { DatabaseChangeLog } from "~/database/changes";
import type { Engine } from "~/lib/engine";
import { DELIVERY_POLL_MS, Delivery, retryDelay } from "~/lib/events/delivery";
import type { ChangeLog } from "~/lib/events/log";
import { CHANGE_BATCH } from "~/lib/events/log";
import type { WorkspaceRecords } from "~/lib/events/records";
import { MemoryWorkspaceRecords } from "~/lib/events/records";
import type { Fact, Handler } from "~/lib/events/source";
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
 * An engine over `state`, its records in the machine's database (in memory
 * without a state dir), with these observers of tasks, by name.
 */
function engineWith(
  state: string | undefined,
  observers: Readonly<Record<string, Handler<TaskEvent>>>,
  print: (line: string) => void = () => undefined
): Engine {
  const engine = testEngine({
    print,
    ...(state ? { records: machine.records(state), state } : {}),
  });
  for (const [name, handler] of Object.entries(observers)) {
    engine.observe(TASKS, handler, { name });
  }
  engines.push(engine);
  return engine;
}

/** Stop delivery and give the records up, as a process exit would. */
async function shutDown(engine: Engine): Promise<void> {
  await engine.dispose();
  engines.splice(engines.indexOf(engine), 1);
}

/** Each observer of the workspace at `state`: its name, place, and failures. */
async function places(
  state: string
): Promise<{ failures: number; name: string; position: number }[]> {
  const records = machine.records(state);
  try {
    return (await records.log.observers()).map((observer) => ({
      failures: observer.failures,
      name: observer.name,
      position: observer.position,
    }));
  } finally {
    await records.close();
  }
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

/** `move` on every database change log, failing the first `fail` calls. */
function losingMoves(fail: number): {
  readonly lost: () => number;
  restore(): void;
} {
  const { move } = DatabaseChangeLog.prototype;
  let lost = 0;
  const spy = vi
    .spyOn(DatabaseChangeLog.prototype, "move")
    .mockImplementation(function (
      this: DatabaseChangeLog,
      ...args: Parameters<ChangeLog["move"]>
    ) {
      if (lost < fail) {
        lost += 1;
        return Promise.reject(new Error("the database is gone"));
      }
      return move.apply(this, args);
    });
  return { lost: () => lost, restore: () => spy.mockRestore() };
}

describe("observing tasks", () => {
  it("hands each fact to every observer; a failing one is filed failing and holds no other back", async () => {
    const state = stateDir();
    const seen: TaskEvent[] = [];
    let failures = 0;
    const lines: string[] = [];
    const engine = engineWith(
      state,
      {
        failing: () => {
          failures += 1;
          throw new Error("not today");
        },
        steady: (payload) => {
          seen.push(payload);
        },
      },
      (line) => lines.push(line)
    );
    const tasks = new Tasks({ store: engine.taskStore });
    await engine.start();

    await tasks.create({ tags: ["review"], title: "First" });
    await tasks.create({ title: "Second" });
    await vi.waitFor(() => expect(titles(seen)).toEqual(["First", "Second"]));
    await vi.waitFor(() => expect(failures).toBe(1));
    await engine.stop();

    expect(seen[0]?.tasks[0]?.after?.tags).toEqual(["review"]);
    const changes = await machine.changes(state, "tasks");
    expect(changes.map((change) => change.payload)).toEqual(seen);
    expect(changes.map((change) => change.type)).toEqual([
      "tasks.changed",
      "tasks.changed",
    ]);
    expect(await places(state)).toEqual([
      { failures: 1, name: "failing", position: 0 },
      { failures: 0, name: "steady", position: 2 },
    ]);
    expect(
      lines.some(
        (line) =>
          line.includes("failing (tasks) failed on tasks.changed 1") &&
          line.includes("not today")
      )
    ).toBe(true);
  });

  it("tries a failing observer again after its backoff, on the fact it failed on, before any newer one", async () => {
    const state = stateDir();
    const outage: { down: boolean } = { down: true };
    const calls: string[] = [];
    const engine = engineWith(state, {
      flaky: (payload) => {
        calls.push(titles([payload]).join());
        if (outage.down) {
          throw new Error("down");
        }
      },
    });
    const tasks = new Tasks({ store: engine.taskStore });
    await engine.start();

    await tasks.create({ title: "First" });
    await vi.waitFor(() => expect(calls).toEqual(["First"]));
    await tasks.create({ title: "Second" });
    // Within its backoff, a newer fact wakes nothing for it.
    await new Promise((settle) => setTimeout(settle, retryDelay(1) / 2));
    expect(calls).toEqual(["First"]);
    outage.down = false;
    await vi.waitFor(
      () => expect(calls).toEqual(["First", "First", "Second"]),
      { timeout: retryDelay(1) + DELIVERY_POLL_MS * 4 }
    );
    await engine.stop();
    expect(await places(state)).toEqual([
      { failures: 0, name: "flaky", position: 2 },
    ]);
  });

  it("hands a fact again, before any newer one, to an observer whose move past it was not saved: at least once", async () => {
    const state = stateDir();
    const calls: string[] = [];
    const lines: string[] = [];
    const engine = engineWith(
      state,
      {
        notify: (payload) => {
          calls.push(titles([payload]).join());
        },
      },
      (line) => lines.push(line)
    );
    const losing = losingMoves(1);
    try {
      await engine.start();
      const tasks = new Tasks({ store: engine.taskStore });
      await tasks.create({ title: "Once" });
      await vi.waitFor(() => expect(losing.lost()).toBe(1));
      await tasks.create({ title: "Twice" });
      await vi.waitFor(async () =>
        expect(await places(state)).toEqual([
          { failures: 0, name: "notify", position: 2 },
        ])
      );
      await engine.stop();
    } finally {
      losing.restore();
    }
    expect(calls).toEqual(["Once", "Once", "Twice"]);
    expect(lines.some((line) => line.includes("may run again"))).toBe(true);
  });

  it("runs a pass in the context the engine was built in, never in the waking call's", async () => {
    const caller = new AsyncLocalStorage<string>();
    const seen: (string | undefined)[] = [];
    const engine = engineWith(stateDir(), {
      context: () => {
        seen.push(caller.getStore());
      },
    });
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

  it("starts a new observer from now: a fact committed before its first start is not handed to it", async () => {
    for (const state of [undefined, stateDir()]) {
      const seen: TaskEvent[] = [];
      const engine = engineWith(state, {
        late: (payload) => {
          seen.push(payload);
        },
      });
      const tasks = new Tasks({ store: engine.taskStore });
      await tasks.create({ title: "Before" });
      await engine.start();
      await tasks.create({ title: "After" });
      await vi.waitFor(() => expect(titles(seen)).toEqual(["After"]));
      await shutDown(engine);
    }
  });

  it("knows an observer by its name: an edited handler keeps its place, a renamed one starts from now", async () => {
    const state = stateDir();
    const calls: string[] = [];
    const first = engineWith(state, {
      notify: (payload) => {
        calls.push(`v1:${titles([payload]).join()}`);
      },
    });
    await first.start();
    await new Tasks({ store: first.taskStore }).create({ title: "Kept" });
    await vi.waitFor(() => expect(calls).toEqual(["v1:Kept"]));
    await shutDown(first);
    // Written while no engine runs: the observer's place is filed, so it is
    // handed this at its next start.
    const between = machine.records(state);
    await new Tasks({ store: between.taskStore }).create({ title: "Between" });
    await between.close();

    // The same name with another body: the same observer, from its place.
    const edited = engineWith(state, {
      notify: (payload) => {
        const title = titles([payload]).join();
        calls.push(`v2:${title.toLowerCase()}`);
      },
    });
    await edited.start();
    await vi.waitFor(() => expect(calls).toEqual(["v1:Kept", "v2:between"]));
    await shutDown(edited);

    // Another name: a new observer, from now.
    const renamed = engineWith(state, {
      announce: (payload) => {
        calls.push(`v3:${titles([payload]).join()}`);
      },
    });
    await renamed.start();
    await new Tasks({ store: renamed.taskStore }).create({ title: "Fresh" });
    await vi.waitFor(() =>
      expect(calls).toEqual(["v1:Kept", "v2:between", "v3:Fresh"])
    );
    await renamed.stop();
    expect(await places(state)).toEqual([
      { failures: 0, name: "announce", position: 3 },
      { failures: 0, name: "notify", position: 2 },
    ]);
  });

  it("refuses two observers of one source under one name, and one with no name", () => {
    const engine = engineWith(undefined, {});
    engine.observe(TASKS, () => undefined, { name: "twice" });
    expect(() =>
      engine.observe(TASKS, () => undefined, { name: "twice" })
    ).toThrow('named "twice" is already declared');
    expect(() => engine.observe(TASKS, () => undefined)).toThrow(
      "give the observer a name"
    );
    // A named handler names itself.
    engine.observe(TASKS, function byFunctionName() {
      return Promise.resolve();
    });
    expect(() =>
      engine.observe(TASKS, () => undefined, { name: "byFunctionName" })
    ).toThrow("already declared");
  });

  it("hands an observer only the types it asked for, and moves it past the rest", async () => {
    const state = stateDir();
    const records = machine.records(state);
    const seen: string[] = [];
    const delivery = new Delivery({ print: () => undefined, records });
    delivery.observe(
      TASKS,
      (handed: Fact) => {
        seen.push(handed.id);
      },
      { name: "picky", types: ["tasks.wanted"] }
    );
    await delivery.start();
    const fact = (id: string, type: string): Fact => ({
      at: new Date(0).toISOString(),
      id,
      type,
    });
    await machine.database.database.transaction((transaction) =>
      records.changes.record(transaction, "tasks", [
        fact("a", "tasks.wanted"),
        fact("b", "tasks.other"),
        fact("c", "tasks.wanted"),
        fact("d", "tasks.other"),
      ])
    );
    delivery.wake();
    await vi.waitFor(async () =>
      expect(await places(state)).toEqual([
        { failures: 0, name: "picky", position: 4 },
      ])
    );
    await delivery.stop();
    await records.close();
    expect(seen).toEqual(["a", "c"]);
  });

  it("commits a task change and its fact together, or neither", async () => {
    const state = stateDir();
    const seen: TaskEvent[] = [];
    const engine = engineWith(state, {
      notify: (payload) => {
        seen.push(payload);
      },
    });
    const tasks = new Tasks({ store: engine.taskStore });
    await engine.start();
    await tasks.create({ title: "Before" });
    await vi.waitFor(() => expect(titles(seen)).toEqual(["Before"]));
    const { database } = machine.database;
    // The database refuses the fact's row: the task must go with it.
    await database.run(
      sql.raw(
        "CREATE TRIGGER refuse_change BEFORE INSERT ON marbles_changes WHEN NEW.payload LIKE '%Lost change%' BEGIN SELECT RAISE(ABORT, 'refused'); END"
      )
    );
    // The database refuses the task's row: no fact may be recorded.
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
    // A rolled-back commit gave its position to nothing: none is skipped.
    expect(
      (await machine.changes(state)).map((change) => change.position)
    ).toEqual([1, 2]);
  });

  it("a handler can change tasks without a deadlock, and that change is delivered too", async () => {
    for (const state of [undefined, stateDir()]) {
      const seen: TaskEvent[] = [];
      let follow: Tasks | undefined;
      const engine = engineWith(state, {
        reviewer: async (payload) => {
          seen.push(payload);
          const created = payload.tasks.find(
            (delta) =>
              delta.before === null && delta.after?.tags.includes("review")
          );
          if (created !== undefined) {
            await follow?.create({ title: `Review ${created.after?.title}` });
          }
        },
      });
      follow = new Tasks({ store: engine.taskStore });
      await engine.start();

      await follow.create({ tags: ["review"], title: "API" });
      await vi.waitFor(() =>
        expect(titles(seen)).toEqual(["API", "Review API"])
      );
    }
  });

  it("remove and edge-only changes reach observers as they committed", async () => {
    const seen: TaskEvent[] = [];
    const engine = engineWith(undefined, {
      notify: (payload) => {
        seen.push(payload);
      },
    });
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

  it("keeps each workspace's facts and observers apart", async () => {
    const seenA: TaskEvent[] = [];
    const seenB: TaskEvent[] = [];
    const [stateA, stateB] = [stateDir(), stateDir()];
    const a = engineWith(stateA, {
      notify: (payload) => {
        seenA.push(payload);
      },
    });
    const b = engineWith(stateB, {
      notify: (payload) => {
        seenB.push(payload);
      },
    });
    await Promise.all([a.start(), b.start()]);

    await new Tasks({ store: a.taskStore }).create({ title: "Only A" });
    await new Tasks({ store: b.taskStore }).create({ title: "Only B" });
    await vi.waitFor(() => {
      expect(titles(seenA)).toEqual(["Only A"]);
      expect(titles(seenB)).toEqual(["Only B"]);
    });
    expect(
      (await machine.changes(stateB)).map((change) => change.position)
    ).toEqual([1]);
    expect(await places(stateA)).toEqual([
      { failures: 0, name: "notify", position: 1 },
    ]);
  });

  it("reads each pass from an observer's place, not from the start of the log", async () => {
    const memory = new MemoryWorkspaceRecords();
    const reads: number[] = [];
    const records: WorkspaceRecords = {
      ...delegate(memory),
      log: {
        ...memory.log,
        read: (query) => {
          reads.push(query.after);
          return memory.log.read(query);
        },
      },
    };
    let delivered = 0;
    const engine = testEngine({ print: () => undefined, records });
    engines.push(engine);
    engine.observe(
      TASKS,
      () => {
        delivered += 1;
      },
      { name: "count" }
    );
    await engine.start();
    const tasks = new Tasks({ store: engine.taskStore });
    const history = CHANGE_BATCH * 2 + 50;
    for (let index = 0; index < history; index += 1) {
      await tasks.create({ title: `T${String(index)}` });
    }
    await vi.waitFor(() => expect(delivered).toBe(history));
    reads.length = 0;
    await tasks.create({ title: "One more" });
    await vi.waitFor(() => expect(delivered).toBe(history + 1));
    expect(reads.length).toBeGreaterThan(0);
    expect(Math.min(...reads)).toBeGreaterThanOrEqual(history);
  });
});

/** `records`' own calls, as a test's records built over it start from. */
function delegate(records: WorkspaceRecords): WorkspaceRecords {
  return {
    claimDelivery: () => records.claimDelivery(),
    close: () => records.close(),
    log: records.log,
    releaseDelivery: () => records.releaseDelivery(),
    taskStore: records.taskStore,
    watch: (listener) => records.watch(listener),
  };
}

describe("delivery lifecycle", () => {
  it("lets several engines over one workspace read and write its tasks, and refuses them to a disposed one", async () => {
    const state = stateDir();
    const first = engineWith(state, {});
    const second = engineWith(state, {});
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
    const { promise: blocked, resolve: release } =
      Promise.withResolvers<void>();
    let entered = false;
    let finished = false;
    const slow: Handler<TaskEvent> = async () => {
      entered = true;
      await blocked;
      finished = true;
    };
    const first = engineWith(state, { slow });
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
    const second = engineWith(state, { slow: () => undefined }, (line) =>
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
    // The handler completed before the stop, so its place moved past it.
    expect(await places(state)).toEqual([
      { failures: 0, name: "slow", position: 1 },
    ]);
  });

  it("two generations over one workspace: the newer takes up each observer where the older left it, handing nothing twice", async () => {
    const state = stateDir();
    const calls: string[] = [];
    const notify =
      (generation: string): Handler<TaskEvent> =>
      (payload) => {
        calls.push(`${generation}:${titles([payload]).join()}`);
      };
    const older = engineWith(state, { notify: notify("old") });
    await older.start();
    const lines: string[] = [];
    const newer = engineWith(state, { notify: notify("new") }, (line) =>
      lines.push(line)
    );
    await newer.start();
    expect(lines.some((line) => line.includes("not delivering here"))).toBe(
      true
    );
    const tasks = new Tasks({ store: newer.taskStore });
    await tasks.create({ title: "One" });
    // Written through the newer's records: the older notices it on its tick.
    await vi.waitFor(() => expect(calls).toEqual(["old:One"]), {
      timeout: DELIVERY_POLL_MS * 5,
    });

    await shutDown(older);
    await tasks.create({ title: "Two" });
    await vi.waitFor(() => expect(calls).toEqual(["old:One", "new:Two"]), {
      timeout: DELIVERY_POLL_MS * 5,
    });
    await newer.stop();
    expect(await places(state)).toEqual([
      { failures: 0, name: "notify", position: 2 },
    ]);
  });

  it("never moves an observer back: a move from a place another deliverer moved it past is refused", async () => {
    const state = stateDir();
    const records = machine.records(state);
    const key = { name: "racer", source: "tasks" };
    const tasks = new Tasks({ store: records.taskStore });
    const { position } = await records.log.declare(key, Date.now());
    await tasks.create({ title: "A" });
    await tasks.create({ title: "B" });
    const now = Date.now();
    expect(
      await records.log.move(key, { from: position, now, to: position + 2 })
    ).toBe(true);
    // A deliverer that read the old place moves from it: nothing changes.
    expect(
      await records.log.move(key, { from: position, now, to: position + 1 })
    ).toBe(false);
    expect((await records.log.declare(key, now)).position).toBe(position + 2);
    await records.close();
  });
});

describe("delivery across processes", () => {
  it("delivers a fact recorded through other records without any change made here", async () => {
    const state = stateDir();
    const seen: TaskEvent[] = [];
    const owner = engineWith(state, {
      notify: (payload) => {
        seen.push(payload);
      },
    });
    await owner.start();
    // Let the start's own pass end, so only noticing the fact can deliver it.
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

  it("delivers a fact whose deliverer crashed between its commit and its delivery, once the next one starts", async () => {
    const state = stateDir();
    const script = join(state, "deliverer.ts");
    writeFileSync(
      script,
      `import { openDatabase } from ${JSON.stringify(resolvePath("src/database/open.ts"))};
import { DatabaseWorkspaceRecords } from ${JSON.stringify(resolvePath("src/database/tasks.ts"))};
import { Delivery } from ${JSON.stringify(resolvePath("src/lib/events/delivery.ts"))};
import { TASKS } from ${JSON.stringify(resolvePath("src/lib/events/source.ts"))};
const opened = await openDatabase(${JSON.stringify(machine.database.file)});
if (opened === undefined) throw new Error("no database");
const records = new DatabaseWorkspaceRecords({ database: opened.database, scope: ${JSON.stringify(basename(state))} });
const delivery = new Delivery({ print: () => undefined, records });
// Its handler never completes: the process dies holding the fact.
delivery.observe(TASKS, () => { process.stdout.write("handling\\n"); return new Promise(() => undefined); }, { name: "notify" });
records.watch(() => delivery.wake());
await delivery.start();
process.stdout.write("delivering\\n");
setInterval(() => undefined, 1000);
`
    );
    const deliverer = spawn("bun", [script], { cwd: resolvePath(".") });
    recordSpawned(deliverer.pid, false);
    let output = "";
    const said = (text: string) =>
      new Promise<void>((ready, failed) => {
        const look = () => {
          if (output.includes(text)) {
            ready();
          }
        };
        deliverer.stdout?.on("data", (chunk: Buffer) => {
          output += chunk.toString();
          look();
        });
        deliverer.once("exit", (code) => failed(new Error(`exited ${code}`)));
        look();
      });
    const seen: TaskEvent[] = [];
    try {
      await said("delivering");
      const writer = machine.records(state);
      await new Tasks({ store: writer.taskStore }).create({
        title: "Committed",
      });
      await writer.close();
      await said("handling");
    } finally {
      deliverer.kill("SIGKILL");
    }
    await new Promise((settle) => deliverer.once("exit", settle));

    const next = engineWith(state, {
      notify: (payload) => {
        seen.push(payload);
      },
    });
    await next.start();
    await vi.waitFor(() => expect(titles(seen)).toEqual(["Committed"]), {
      timeout: DELIVERY_POLL_MS * 5,
    });
    expect(await places(state)).toEqual([
      { failures: 0, name: "notify", position: 1 },
    ]);
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
    const survivor = engineWith(state, {
      notify: (payload) => {
        seen.push(payload);
      },
    });
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

describe("compaction", () => {
  const DAY = 24 * 60 * 60 * 1000;

  /** A fact of `type` in the tasks source. */
  const fact = (id: string): Fact => ({
    at: new Date(0).toISOString(),
    id,
    type: "tasks.changed",
  });

  /** Record `ids` as facts of the workspace at `state`, now. */
  async function record(state: string, ids: readonly string[]): Promise<void> {
    const records = machine.records(state);
    try {
      await machine.database.database.transaction((transaction) =>
        records.changes.record(transaction, "tasks", ids.map(fact))
      );
    } finally {
      await records.close();
    }
  }

  it("keeps giving positions from the counter once every fact was removed", async () => {
    const state = stateDir();
    await record(state, ["a", "b", "c"]);
    const log = new DatabaseChangeLog(
      machine.database.database,
      basename(state)
    );
    const later = Date.now() + DAY;
    expect(await log.compact({ before: later, seenSince: later })).toBe(3);
    expect(await machine.changes(state)).toEqual([]);
    await record(state, ["d"]);
    expect(
      (await machine.changes(state)).map((change) => change.position)
    ).toEqual([4]);
    expect(await log.head()).toBe(4);
  });

  it("removes only old facts every observer seen within the retention has completed", async () => {
    const state = stateDir();
    const log = new DatabaseChangeLog(
      machine.database.database,
      basename(state)
    );
    const now = Date.now();
    const behind = { name: "behind", source: "tasks" };
    const ahead = { name: "ahead", source: "tasks" };
    await log.declare(behind, now);
    await log.declare(ahead, now);
    await record(state, ["a", "b", "c", "d"]);
    await log.move(ahead, { from: 0, now, to: 4 });
    await log.move(behind, { from: 0, now, to: 2 });

    // Recent facts stay, however far every observer has got.
    expect(await log.compact({ before: now - DAY, seenSince: now - DAY })).toBe(
      0
    );
    // Old ones go up to the observer furthest behind.
    const later = now + DAY;
    expect(await log.compact({ before: later, seenSince: now - DAY })).toBe(2);
    expect(
      (await machine.changes(state)).map((change) => change.position)
    ).toEqual([3, 4]);
    // An observer not seen since the bound holds nothing back.
    expect(await log.compact({ before: later, seenSince: later })).toBe(2);
    expect(await machine.changes(state)).toEqual([]);
  });

  it("tells an observer that fell behind what it missed, and goes on after it", async () => {
    const state = stateDir();
    const records = machine.records(state);
    const now = { at: Date.now() };
    const lines: string[] = [];
    const seen: string[] = [];
    const delivery = (print: (line: string) => void) => {
      const built = new Delivery({
        now: () => now.at,
        print,
        records,
        retention: DAY,
      });
      built.observe(
        TASKS,
        (handed: Fact) => {
          seen.push(handed.id);
        },
        { name: "absent" }
      );
      return built;
    };
    // Filed once, then never seen again while the log moves on.
    const first = delivery(() => undefined);
    await first.start();
    await first.stop();
    await record(state, ["a", "b"]);
    now.at += 2 * DAY;
    await new DatabaseChangeLog(
      machine.database.database,
      basename(state)
    ).compact({ before: now.at - DAY, seenSince: now.at - DAY });
    await record(state, ["c"]);

    const back = delivery((line) => lines.push(line));
    await back.start();
    await vi.waitFor(() => expect(seen).toEqual(["c"]));
    await back.stop();
    expect(
      lines.some((line) =>
        line.includes("absent (tasks) missed changes 1 to 2")
      )
    ).toBe(true);
    expect((await records.log.observers())[0]?.missed).toEqual({
      from: 1,
      through: 2,
    });

    // Told once: the next start finds it caught up, and says nothing.
    const quiet: string[] = [];
    const again = delivery((line) => quiet.push(line));
    await again.start();
    await again.stop();
    expect(quiet.filter((line) => line.includes("missed"))).toEqual([]);
    expect((await records.log.observers())[0]?.missed).toEqual({
      from: 1,
      through: 2,
    });
    await records.close();
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
delivery.observe(TASKS, () => undefined, { name: "idle" });
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
      ...delegate(memory),
      claimDelivery: () => granted,
      log: {
        ...memory.log,
        head: () => {
          reads += 1;
          return memory.log.head();
        },
      },
      releaseDelivery: () => {
        released += 1;
        return Promise.resolve();
      },
    };
    const delivery = new Delivery({ print: () => undefined, records });
    delivery.observe(TASKS, () => undefined, { name: "idle" });
    const starting = delivery.start();
    await delivery.stop();
    grant(undefined);
    await starting;
    expect(released).toBe(1);
    await new Promise((settle) => setTimeout(settle, DELIVERY_POLL_MS * 2));
    expect(reads).toBe(0);
  });

  it("never runs once stopped while its start was still filing observers, and gives the claim up", async () => {
    const memory = new MemoryWorkspaceRecords();
    const { promise: filed, resolve: file } = Promise.withResolvers<void>();
    const { promise: entered, resolve: enter } = Promise.withResolvers<void>();
    let released = 0;
    let passes = 0;
    const records: WorkspaceRecords = {
      ...delegate(memory),
      log: {
        ...memory.log,
        declare: async (key, now) => {
          enter();
          await filed;
          return memory.log.declare(key, now);
        },
        head: () => {
          passes += 1;
          return memory.log.head();
        },
      },
      releaseDelivery: () => {
        released += 1;
        return Promise.resolve();
      },
    };
    const delivery = new Delivery({ print: () => undefined, records });
    delivery.observe(TASKS, () => undefined, { name: "idle" });
    const starting = delivery.start();
    await entered;
    await delivery.stop();
    file();
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
      ...delegate(memory),
      log: {
        ...memory.log,
        head: () => {
          reads += 1;
          return memory.log.head();
        },
      },
    };
    const engine = testEngine({ print: () => undefined, records });
    engines.push(engine);
    engine.observe(TASKS, () => undefined, { name: "idle" });
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

// Kept from the file-backed store's days: an old tasks.json is no input.
describe("an earlier Marbles' files", () => {
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

    const engine = engineWith(state, { idle: () => undefined });
    await engine.start();
    const tasks = new Tasks({ store: engine.taskStore });
    expect((await tasks.list()).items).toEqual([]);
    await tasks.create({ title: "New" });
    expect(await storedTitles(state)).toEqual(["New"]);
    expect(readFileSync(path, "utf8")).toBe(old);
  });
});
