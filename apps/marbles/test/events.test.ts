import { AsyncLocalStorage } from "node:async_hooks";
import { spawn } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { basename, join, resolve as resolvePath } from "node:path";
import { thisProcess } from "@foundry/lib/process-identity";
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
import { openDatabase } from "~/database/open";
import { DatabaseWorkspaceRecords } from "~/database/tasks";
import type { Engine } from "~/lib/engine";
import { DELIVERY_POLL_MS, Delivery, retryDelay } from "~/lib/events/delivery";
import type { ChangeLog } from "~/lib/events/log";
import { CHANGE_BATCH, MemoryChangeLog } from "~/lib/events/log";
import type { WorkspaceRecords } from "~/lib/events/records";
import { MemoryWorkspaceRecords } from "~/lib/events/records";
import type { Fact, Handler } from "~/lib/events/source";
import { TASKS } from "~/lib/events/source";
import { recordSpawned } from "~/process/spawned";
import { ManualClock } from "./helpers/clock";
import { testEngine } from "./helpers/engine";
import type { TestMachine } from "./helpers/records";
import { testMachine } from "./helpers/records";

const CLOSED = /closed/;
const REFUSED = /refused/;

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

function stateDir(): string {
  return machine.workspace();
}

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
    const records = machine.records(state);
    const clock = new ManualClock();
    const seen: TaskEvent[] = [];
    let failures = 0;
    const lines: string[] = [];
    const delivery = new Delivery({
      clock,
      print: (line) => lines.push(line),
      records,
    });
    delivery.observe(
      TASKS,
      () => {
        failures += 1;
        throw new Error("not today");
      },
      { name: "failing" }
    );
    delivery.observe(
      TASKS,
      (payload: TaskEvent) => {
        seen.push(payload);
      },
      { name: "steady" }
    );
    await delivery.start();
    await delivery.idle();
    const tasks = new Tasks({ store: records.taskStore });

    await tasks.create({ tags: ["review"], title: "First" });
    await tasks.create({ title: "Second" });
    delivery.wake();
    await delivery.idle();
    await delivery.stop();

    expect(titles(seen)).toEqual(["First", "Second"]);
    expect(failures).toBe(1);
    expect(seen[0]?.tasks[0]?.after?.tags).toEqual(["review"]);
    const changes = await machine.changes(state, "tasks");
    expect(changes.map((change) => change.payload)).toEqual(seen);
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
    await records.close();
  });

  it("tries a failing observer again once its backoff is over, on the fact it failed on, before any newer one", async () => {
    const records = new MemoryWorkspaceRecords();
    const clock = new ManualClock();
    const outage: { down: boolean } = { down: true };
    const calls: string[] = [];
    const delivery = new Delivery({ clock, print: () => undefined, records });
    delivery.observe(
      TASKS,
      (payload: TaskEvent) => {
        calls.push(titles([payload]).join());
        if (outage.down) {
          throw new Error("down");
        }
      },
      { name: "flaky" }
    );
    await delivery.start();
    const tasks = new Tasks({ store: records.taskStore });

    await tasks.create({ title: "First" });
    delivery.wake();
    await delivery.idle();
    expect(calls).toEqual(["First"]);
    await tasks.create({ title: "Second" });
    clock.advance(retryDelay(1) - 1);
    delivery.wake();
    await delivery.idle();
    expect(calls).toEqual(["First"]);

    outage.down = false;
    clock.advance(1);
    delivery.wake();
    await delivery.idle();
    expect(calls).toEqual(["First", "First", "Second"]);
    expect((await records.log.observers())[0]).toMatchObject({
      failures: 0,
      lastError: null,
      position: 2,
    });
    await delivery.stop();
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

  it("runs a pass in the context the delivery was built in, never in the waking call's", async () => {
    const caller = new AsyncLocalStorage<string>();
    const seen: (string | undefined)[] = [];
    const records = machine.records(stateDir());
    const delivery = new Delivery({ print: () => undefined, records });
    delivery.observe(
      TASKS,
      () => {
        seen.push(caller.getStore());
      },
      { name: "context" }
    );
    await delivery.start();
    await delivery.idle();
    await caller.run("a command's output", async () => {
      await new Tasks({ store: records.taskStore }).create({ title: "Woken" });
      delivery.wake();
    });
    await delivery.idle();
    await delivery.stop();
    expect(seen).toEqual([undefined]);
    await records.close();
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
    const between = machine.records(state);
    await new Tasks({ store: between.taskStore }).create({ title: "Between" });
    await between.close();

    const edited = engineWith(state, {
      notify: (payload) => {
        const title = titles([payload]).join();
        calls.push(`v2:${title.toLowerCase()}`);
      },
    });
    await edited.start();
    await vi.waitFor(() => expect(calls).toEqual(["v1:Kept", "v2:between"]));
    await shutDown(edited);

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
    await database.run(
      sql.raw(
        "CREATE TRIGGER refuse_change BEFORE INSERT ON marbles_changes WHEN NEW.payload LIKE '%Lost change%' BEGIN SELECT RAISE(ABORT, 'refused'); END"
      )
    );
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

function logOf(records: WorkspaceRecords): WorkspaceRecords["log"] {
  const { log } = records;
  return {
    compact: (bound) => log.compact(bound),
    declare: (key, now) => log.declare(key, now),
    fail: (key, failure) => log.fail(key, failure),
    head: () => log.head(),
    move: (key, move) => log.move(key, move),
    observers: () => log.observers(),
    read: (query) => log.read(query),
    unstick: (key) => log.unstick(key),
  };
}

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

describe("a handler's time, and the observers beside it", () => {
  const LIMIT = 60_000;

  function delivering(options: { readonly stopGrace?: number } = {}) {
    const records = new MemoryWorkspaceRecords();
    const clock = new ManualClock();
    const lines: string[] = [];
    const delivery = new Delivery({
      clock,
      handlerTimeout: LIMIT,
      print: (line) => lines.push(line),
      records,
      ...options,
    });
    const tasks = new Tasks({ store: records.taskStore });
    return { clock, delivery, lines, records, tasks };
  }

  function held() {
    const calls: { readonly fact: string; release(): void }[] = [];
    const handler = (payload: TaskEvent) => {
      const { promise, resolve } = Promise.withResolvers<void>();
      calls.push({ fact: titles([payload]).join(), release: resolve });
      return promise;
    };
    return { calls, handler };
  }

  it("never delays one observer for another that is slow, failing or hung", async () => {
    const { delivery, records, tasks } = delivering();
    const hung = held();
    const healthy: string[] = [];
    delivery.observe(TASKS, hung.handler, { name: "hung" });
    delivery.observe(
      TASKS,
      () => {
        throw new Error("down");
      },
      { name: "failing" }
    );
    delivery.observe(
      TASKS,
      (payload: TaskEvent) => {
        healthy.push(titles([payload]).join());
      },
      { name: "healthy" }
    );
    await delivery.start();
    await tasks.create({ title: "One" });
    await tasks.create({ title: "Two" });
    delivery.wake();

    await vi.waitFor(() => expect(healthy).toEqual(["One", "Two"]));
    expect(hung.calls.map((call) => call.fact)).toEqual(["One"]);
    const states = await records.log.observers();
    expect(states.map((state) => [state.name, state.position])).toEqual([
      ["failing", 0],
      ["healthy", 2],
      ["hung", 0],
    ]);
    hung.calls[0]?.release();
    await delivery.stop();
  });

  it("counts a call past its limit as a failure, keeps the place, says it is stuck, and calls again only once the old call settles", async () => {
    const { clock, delivery, lines, records, tasks } = delivering();
    const hung = held();
    delivery.observe(TASKS, hung.handler, { name: "hung", timeout: 5000 });
    await delivery.start();
    const began = clock.now();
    await tasks.create({ title: "Slow" });
    delivery.wake();
    await vi.waitFor(() => expect(hung.calls).toHaveLength(1));

    clock.advance(5000);
    await delivery.idle();
    const [stuck] = await records.log.observers();
    expect(stuck).toMatchObject({
      failures: 1,
      lastError: "the handler did not finish within 5s",
      position: 0,
      stuckSince: began,
    });
    expect(lines.some((line) => line.includes("once this call settles"))).toBe(
      true
    );

    clock.advance(retryDelay(1) * 10);
    delivery.wake();
    await delivery.idle();
    expect(hung.calls).toHaveLength(1);

    hung.calls[0]?.release();
    await vi.waitFor(() => expect(hung.calls).toHaveLength(2));
    expect(hung.calls[1]?.fact).toBe("Slow");
    expect((await records.log.observers())[0]).toMatchObject({
      position: 0,
      stuckSince: null,
    });
    hung.calls[1]?.release();
    await vi.waitFor(async () =>
      expect((await records.log.observers())[0]).toMatchObject({
        failures: 0,
        position: 1,
      })
    );
    await delivery.stop();
  });

  it("stops after the grace without a handler still in flight, its place unmoved, even once it finishes", async () => {
    const { clock, delivery, records, tasks } = delivering({
      stopGrace: 10_000,
    });
    const hung = held();
    delivery.observe(TASKS, hung.handler, { name: "hung" });
    await delivery.start();
    await tasks.create({ title: "Late" });
    delivery.wake();
    await vi.waitFor(() => expect(hung.calls).toHaveLength(1));

    let stopped = false;
    const stopping = delivery.stop().then(() => {
      stopped = true;
    });
    await vi.waitFor(() => expect(clock.waiting).toBe(2));
    expect(stopped).toBe(false);
    clock.advance(10_000);
    await stopping;

    hung.calls[0]?.release();
    await new Promise((settle) => setImmediate(settle));
    expect((await records.log.observers())[0]).toMatchObject({
      failures: 0,
      position: 0,
    });
  });

  it("stops at once when every call in flight finishes within the grace, moving their places", async () => {
    const { delivery, records, tasks } = delivering();
    const slow = held();
    delivery.observe(TASKS, slow.handler, { name: "slow" });
    await delivery.start();
    await tasks.create({ title: "Finishing" });
    delivery.wake();
    await vi.waitFor(() => expect(slow.calls).toHaveLength(1));
    const stopping = delivery.stop();
    slow.calls[0]?.release();
    await stopping;
    expect((await records.log.observers())[0]?.position).toBe(1);
  });

  it("hands an observer that writes to its own source only what was there when its pass began", async () => {
    const records = new MemoryWorkspaceRecords();
    const tasks = new Tasks({ store: records.taskStore });
    const trace: string[] = [];
    const log: WorkspaceRecords["log"] = {
      ...records.log,
      head: async () => {
        const head = await records.log.head();
        trace.push(`pass at ${String(head)}`);
        return head;
      },
    };
    const traced = new Delivery({
      clock: new ManualClock(),
      print: () => undefined,
      records: { ...delegate(records), log },
    });
    const echoes: string[] = [];
    traced.observe(
      TASKS,
      async (payload: TaskEvent) => {
        const [title = ""] = titles([payload]);
        trace.push(`handed ${title}`);
        if (echoes.length < 3 && title.startsWith("Seed")) {
          echoes.push(`Echo ${String(echoes.length + 1)}`);
          await tasks.create({ title: echoes.at(-1) ?? "" });
        }
      },
      { name: "echo" }
    );
    await traced.start();
    await traced.idle();
    for (let index = 0; index < CHANGE_BATCH; index += 1) {
      await tasks.create({ title: `Seed ${String(index)}` });
    }
    traced.wake();
    await vi.waitFor(() =>
      expect(trace.filter((line) => line.startsWith("handed"))).toHaveLength(
        CHANGE_BATCH + 3
      )
    );
    await traced.idle();
    await traced.stop();

    const lastSeed = trace.indexOf(`handed Seed ${String(CHANGE_BATCH - 1)}`);
    const firstEcho = trace.indexOf("handed Echo 1");
    expect(firstEcho).toBeGreaterThan(lastSeed);
    expect(
      trace
        .slice(lastSeed, firstEcho)
        .some((line) => line === `pass at ${String(CHANGE_BATCH + 3)}`)
    ).toBe(true);
  });
});

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
    const lines: string[] = [];
    const second = engineWith(state, { slow: () => undefined }, (line) =>
      lines.push(line)
    );
    await second.start();
    expect(disposed).toBe(false);
    expect(
      lines.some((line) => line.startsWith("[observe] not delivering"))
    ).toBe(true);

    release();
    await disposing;
    engines.splice(engines.indexOf(first), 1);
    expect(finished).toBe(true);
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

  it("a retired generation, still alive for its runs, delivers nothing more; the newer delivers within a tick", async () => {
    const state = stateDir();
    const calls: string[] = [];
    const notify =
      (generation: string): Handler<TaskEvent> =>
      (payload) => {
        calls.push(`${generation}:${titles([payload]).join()}`);
      };
    const olderRecords = machine.records(state);
    const older = testEngine({
      print: () => undefined,
      records: olderRecords,
      state,
    });
    older.observe(TASKS, notify("old"), { name: "notify" });
    engines.push(older);
    await older.start();
    const newer = engineWith(state, { notify: notify("new") });
    await newer.start();
    const tasks = new Tasks({ store: older.taskStore });
    await tasks.create({ title: "Before" });
    await vi.waitFor(() => expect(calls).toEqual(["old:Before"]));

    const letGo: string[] = [];
    await older.retire(thisProcess(), {
      onLetGo: (runId) => letGo.push(runId),
    });
    const key = { name: "notify", source: "tasks" };
    expect(
      await olderRecords.log.fail(key, {
        error: "late",
        now: Date.now(),
        retryAt: Date.now(),
        stuckSince: Date.now(),
      })
    ).toBe(false);
    expect(
      await olderRecords.log.move(key, {
        from: 0,
        handed: false,
        now: Date.now(),
        to: 9,
      })
    ).toEqual({ kind: "unclaimed" });
    await tasks.create({ title: "After" });
    await vi.waitFor(() => expect(calls).toEqual(["old:Before", "new:After"]), {
      timeout: DELIVERY_POLL_MS * 5,
    });
    expect(calls).toEqual(["old:Before", "new:After"]);
    expect(letGo).toEqual([]);
    expect((await places(state))[0]).toMatchObject({
      failures: 0,
      name: "notify",
    });
  });

  it("never moves an observer back: a move from a place another deliverer moved it past is refused", async () => {
    const state = stateDir();
    const records = machine.records(state);
    expect(await records.claimDelivery()).toBeUndefined();
    const key = { name: "racer", source: "tasks" };
    const tasks = new Tasks({ store: records.taskStore });
    const { position } = await records.log.declare(key, Date.now());
    await tasks.create({ title: "A" });
    await tasks.create({ title: "B" });
    const now = Date.now();
    const move = (to: number) =>
      records.log.move(key, { from: position, handed: false, now, to });
    expect(await move(position + 2)).toEqual({ kind: "moved", missed: null });
    expect(await move(position + 1)).toEqual({ kind: "elsewhere" });
    expect((await records.log.declare(key, now)).position).toBe(position + 2);
    await records.close();
  });

  it("refuses, and drops, every observer write from records that no longer hold the claim, however late it lands", async () => {
    const state = stateDir();
    const key = { name: "same", source: "tasks" };
    const older = machine.records(state);
    expect(await older.claimDelivery()).toBeUndefined();
    await older.log.declare(key, Date.now());
    await older.releaseDelivery();
    const newer = machine.records(state);
    expect(await newer.claimDelivery()).toBeUndefined();
    const stuck = {
      error: "the handler did not finish within 0s",
      now: Date.now(),
      retryAt: Date.now() + 1000,
      stuckSince: 1234,
    };
    expect(await newer.log.fail(key, stuck)).toBe(true);

    expect(await older.log.unstick(key)).toBe(false);
    expect(await older.log.fail(key, { ...stuck, stuckSince: null })).toBe(
      false
    );
    expect(
      await older.log.move(key, {
        from: 0,
        handed: false,
        now: Date.now(),
        to: 1,
      })
    ).toEqual({ kind: "unclaimed" });
    expect((await newer.log.observers())[0]).toMatchObject({
      failures: 1,
      position: 0,
      stuckSince: 1234,
    });
    await older.close();
    await newer.close();
  });

  it("says so, and goes on, when a write it makes about an observer is refused for the claim", async () => {
    const records = new MemoryWorkspaceRecords();
    const lines: string[] = [];
    const refused: WorkspaceRecords["log"] = {
      ...records.log,
      move: () => Promise.resolve({ kind: "unclaimed" }),
    };
    const delivery = new Delivery({
      clock: new ManualClock(),
      print: (line) => lines.push(line),
      records: { ...delegate(records), log: refused },
    });
    let calls = 0;
    delivery.observe(
      TASKS,
      () => {
        calls += 1;
      },
      { name: "fenced" }
    );
    await delivery.start();
    await new Tasks({ store: records.taskStore }).create({ title: "One" });
    delivery.wake();
    await delivery.idle();
    await delivery.stop();
    expect(calls).toBe(1);
    expect(lines).toEqual([
      "[observe] fenced (tasks): not moving its place: this engine no longer delivers this workspace's changes",
    ]);
  });
});

describe("delivery across processes", () => {
  it("delivers a fact recorded through other records without any change made here", async () => {
    const state = stateDir();
    const seen: TaskEvent[] = [];
    const records = machine.records(state);
    const owner = new Delivery({ print: () => undefined, records });
    owner.observe(
      TASKS,
      (payload: TaskEvent) => {
        seen.push(payload);
      },
      { name: "notify" }
    );
    await owner.start();
    await owner.idle();
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
      await owner.stop();
      await records.close();
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
    const { claimDelivery } = DatabaseWorkspaceRecords.prototype;
    let claims = 0;
    const counting = vi
      .spyOn(DatabaseWorkspaceRecords.prototype, "claimDelivery")
      .mockImplementation(function (this: DatabaseWorkspaceRecords) {
        claims += 1;
        return claimDelivery.call(this);
      });
    try {
      await survivor.start();
      await new Tasks({ store: survivor.taskStore }).create({
        title: "Waiting",
      });
      await vi.waitFor(() => expect(claims).toBeGreaterThanOrEqual(3), {
        timeout: DELIVERY_POLL_MS * 5,
      });
      expect(seen).toEqual([]);
    } finally {
      counting.mockRestore();
      holder.kill("SIGKILL");
    }
    await new Promise((settle) => holder.once("exit", settle));
    await vi.waitFor(() => expect(titles(seen)).toEqual(["Waiting"]), {
      timeout: DELIVERY_POLL_MS * 5,
    });
  });
});

describe("an engine that observes nothing", () => {
  const DAY = 24 * 60 * 60 * 1000;

  function deliveryOver(
    records: WorkspaceRecords,
    clock: ManualClock,
    lines: string[],
    label: string
  ) {
    return new Delivery({
      clock,
      print: (line) => lines.push(`${label} ${line}`),
      records,
      retention: DAY,
    });
  }

  function watching(delivery: Delivery, seen: string[]): Delivery {
    delivery.observe(
      TASKS,
      (fact: TaskEvent) => {
        seen.push(titles([fact]).join());
      },
      { name: "watcher" }
    );
    return delivery;
  }

  it("does not stand in the way of one that observes, when it started first", async () => {
    const state = stateDir();
    const clock = new ManualClock();
    const lines: string[] = [];
    const seen: string[] = [];
    const recordsA = machine.records(state);
    const recordsB = machine.records(state);
    const a = deliveryOver(recordsA, clock, lines, "A");
    const b = watching(deliveryOver(recordsB, clock, lines, "B"), seen);
    await a.start();
    await b.start();
    await new Tasks({ store: recordsB.taskStore }).create({ title: "x" });
    b.wake();
    await b.idle();
    clock.advance(DELIVERY_POLL_MS);
    await b.idle();

    expect(seen).toEqual(["x"]);
    expect(lines).toEqual([]);
    await a.stop();
    await b.stop();
    await recordsA.close();
    await recordsB.close();
  });

  it("does not take delivery in the gap between a deliverer and its successor", async () => {
    const state = stateDir();
    const clock = new ManualClock();
    const lines: string[] = [];
    const seen: string[] = [];
    const recordsB = machine.records(state);
    const recordsA = machine.records(state);
    const recordsB2 = machine.records(state);
    const b = watching(deliveryOver(recordsB, clock, lines, "B"), seen);
    const a = deliveryOver(recordsA, clock, lines, "A");
    await b.start();
    await a.start();
    await b.stop();
    clock.advance(DELIVERY_POLL_MS);
    clock.advance(DELIVERY_POLL_MS);
    await a.idle();
    const b2 = watching(deliveryOver(recordsB2, clock, lines, "B2"), seen);
    await b2.start();
    await new Tasks({ store: recordsB2.taskStore }).create({
      title: "after handoff",
    });
    b2.wake();
    await b2.idle();

    expect(seen).toEqual(["after handoff"]);
    expect(lines.filter((line) => line.startsWith("A "))).toEqual([]);
    await a.stop();
    await b2.stop();
    for (const records of [recordsA, recordsB, recordsB2]) {
      await records.close();
    }
  });

  it("does not stand in the way from another connection to the database, as another process's engine would", async () => {
    const state = stateDir();
    const clock = new ManualClock();
    const lines: string[] = [];
    const seen: string[] = [];
    const elsewhere = await openDatabase(machine.database.file);
    if (elsewhere === undefined) {
      throw new Error("no database");
    }
    const recordsA = new DatabaseWorkspaceRecords({
      database: elsewhere.database,
      scope: basename(state),
    });
    const recordsB = machine.records(state);
    const a = deliveryOver(recordsA, clock, lines, "A");
    await a.start();
    clock.advance(DELIVERY_POLL_MS);
    await a.idle();
    const b = watching(deliveryOver(recordsB, clock, lines, "B"), seen);
    await b.start();
    await new Tasks({ store: recordsB.taskStore }).create({ title: "across" });
    b.wake();
    await b.idle();

    expect(seen).toEqual(["across"]);
    await a.stop();
    await b.stop();
    await recordsA.close();
    await recordsB.close();
    elsewhere.close();
  });

  it("never compacts away what an observer waiting behind another engine is still to receive", async () => {
    const state = stateDir();
    const clock = new ManualClock(Date.now());
    const lines: string[] = [];
    const seen: string[] = [];
    const recordsA = machine.records(state);
    const recordsB = machine.records(state);
    const a = deliveryOver(recordsA, clock, lines, "A");
    const b = watching(deliveryOver(recordsB, clock, lines, "B"), seen);
    await a.start();
    await b.start();
    const spy = vi.spyOn(Date, "now").mockImplementation(() => clock.now());
    try {
      await new Tasks({ store: recordsB.taskStore }).create({ title: "for B" });
    } finally {
      spy.mockRestore();
    }
    for (let step = 0; step < 4; step += 1) {
      clock.advance(DAY / 2 + 11 * 60 * 1000);
      await a.idle();
      await b.idle();
    }
    await a.stop();
    clock.advance(DELIVERY_POLL_MS);
    await b.idle();
    b.wake();
    await b.idle();

    expect(seen).toEqual(["for B"]);
    expect(lines.filter((line) => line.includes("missed"))).toEqual([]);
    expect((await recordsB.log.observers())[0]).toMatchObject({
      missed: null,
    });
    await b.stop();
    await recordsA.close();
    await recordsB.close();
  });
});

describe("a delivery stopped with no grace, as retire stops it", () => {
  it("gives the claim up at once, leaves no tick, and writes nothing when its held handler returns", async () => {
    const state = stateDir();
    const records = machine.records(state);
    const clock = new ManualClock();
    const { promise: held, resolve: release } = Promise.withResolvers<void>();
    const { promise: entered, resolve: enter } = Promise.withResolvers<void>();
    const delivery = new Delivery({ clock, print: () => undefined, records });
    delivery.observe(
      TASKS,
      async () => {
        enter();
        await held;
      },
      { name: "held" }
    );
    await delivery.start();
    await new Tasks({ store: records.taskStore }).create({ title: "held" });
    delivery.wake();
    await entered;

    await delivery.stop({ grace: 0 });
    expect(clock.periods).toEqual([]);
    const successor = machine.records(state);
    expect(await successor.claimDelivery()).toBeUndefined();

    release();
    await delivery.idle();
    expect((await successor.log.observers())[0]).toMatchObject({
      failures: 0,
      name: "held",
      position: 0,
    });
    await successor.close();
    await records.close();
  });
});

describe("compaction", () => {
  const DAY = 24 * 60 * 60 * 1000;
  const LONG_AFTER = 2 * DAY;

  const fact = (id: string): Fact => ({
    at: new Date(0).toISOString(),
    id,
    type: "tasks.changed",
  });

  async function record(
    state: string,
    ids: readonly string[],
    at = Date.now()
  ): Promise<void> {
    const records = machine.records(state);
    const spy = vi.spyOn(Date, "now").mockReturnValue(at);
    try {
      await machine.database.database.transaction((transaction) =>
        records.changes.record(transaction, "tasks", ids.map(fact))
      );
    } finally {
      spy.mockRestore();
      await records.close();
    }
  }

  async function deliverer(state: string) {
    const records = machine.records(state);
    expect(await records.claimDelivery()).toBeUndefined();
    return records;
  }

  it("keeps giving positions from the counter once every fact was removed", async () => {
    const state = stateDir();
    await record(state, ["a", "b", "c"]);
    const records = await deliverer(state);
    const later = Date.now() + DAY;
    expect(
      await records.log.compact({
        before: later,
        now: later,
        registered: [],
        seenSince: later,
      })
    ).toEqual({ done: true, removed: 3 });
    expect(await machine.changes(state)).toEqual([]);
    await record(state, ["d"]);
    expect(
      (await machine.changes(state)).map((change) => change.position)
    ).toEqual([4]);
    expect(await records.log.head()).toBe(4);
    await records.close();
  });

  it("removes only old facts every observer holding them back has completed, whichever engine compacts", async () => {
    const state = stateDir();
    const records = await deliverer(state);
    const { log } = records;
    const now = Date.now();
    const behind = { name: "behind", source: "tasks" };
    const ahead = { name: "ahead", source: "tasks" };
    await log.declare(behind, now);
    await log.declare(ahead, now);
    await record(state, ["a", "b", "c", "d"]);
    await log.move(ahead, { from: 0, handed: false, now, to: 4 });
    await log.move(behind, { from: 0, handed: false, now, to: 2 });
    const later = now + DAY;
    const bound = (seenSince: number, registered = [] as (typeof ahead)[]) => ({
      before: later,
      now: seenSince + 1,
      registered,
      seenSince,
    });

    const none = { done: true, removed: 0 };
    expect(
      await log.compact({ ...bound(now - DAY), before: now - DAY })
    ).toEqual(none);
    const other = machine.records(state);
    expect(await other.log.compact(bound(now - DAY))).toEqual({
      done: true,
      removed: 2,
    });
    await other.close();
    expect(
      (await machine.changes(state)).map((change) => change.position)
    ).toEqual([3, 4]);
    expect(await log.compact(bound(later + 1, [ahead, behind]))).toEqual(none);
    expect(await log.compact(bound(later + DAY))).toEqual({
      done: true,
      removed: 2,
    });
    expect(await machine.changes(state)).toEqual([]);
    await records.close();
  });

  it("loses nothing an observer stuck in a call past the retention still needs, once its call settles", async () => {
    const state = stateDir();
    const records = machine.records(state);
    const clock = new ManualClock(Date.now());
    const lines: string[] = [];
    const calls: string[] = [];
    const { promise: hold, resolve: release } = Promise.withResolvers<void>();
    const delivery = new Delivery({
      clock,
      handlerTimeout: 10,
      print: (line) => lines.push(line),
      records,
      retention: DAY,
    });
    delivery.observe(
      TASKS,
      (handed: Fact) => {
        calls.push(handed.id);
        return calls.length === 1 ? hold : undefined;
      },
      { name: "live" }
    );
    await delivery.start();
    await delivery.idle();
    await record(state, ["first", "second"], clock.now());
    delivery.wake();
    await vi.waitFor(() => expect(calls).toEqual(["first"]));
    clock.advance(10);
    await delivery.idle();

    clock.advance(LONG_AFTER);
    delivery.wake();
    await delivery.idle();
    expect(await records.log.read({ after: 0, source: "tasks" })).toHaveLength(
      2
    );

    release();
    await vi.waitFor(() => expect(calls).toEqual(["first", "first", "second"]));
    await delivery.idle();
    expect((await records.log.observers())[0]).toMatchObject({
      failures: 0,
      missed: null,
      position: 2,
      stuckSince: null,
    });
    expect(lines.some((line) => line.includes("missed"))).toBe(false);
    await delivery.stop();
    await records.close();
  });

  it("tells an observer no engine registered for longer than the retention what it missed, once, and goes on after it", async () => {
    const state = stateDir();
    const records = machine.records(state);
    const clock = new ManualClock(Date.now());
    const seen: string[] = [];
    const delivery = (print: (line: string) => void) => {
      const built = new Delivery({ clock, print, records, retention: DAY });
      built.observe(
        TASKS,
        (handed: Fact) => {
          seen.push(handed.id);
        },
        { name: "absent" }
      );
      return built;
    };
    const first = delivery(() => undefined);
    await first.start();
    await first.stop();
    await record(state, ["a", "b"], clock.now());
    clock.advance(LONG_AFTER);
    const compactor = await deliverer(state);
    await compactor.log.compact({
      before: clock.now() - DAY,
      now: clock.now(),
      registered: [],
      seenSince: clock.now() - DAY,
    });
    await compactor.releaseDelivery();
    await compactor.close();
    await record(state, ["c"], clock.now());

    const lines: string[] = [];
    const back = delivery((line) => lines.push(line));
    await back.start();
    await back.idle();
    await back.stop();
    expect(seen).toEqual(["c"]);
    expect(lines.filter((line) => line.includes("missed"))).toEqual([
      "[observe] absent (tasks) missed changes 1 to 2: they were removed before it received them; it goes on after them",
    ]);
    expect((await records.log.observers())[0]).toMatchObject({
      missed: { from: 1, through: 2 },
      position: 3,
    });

    const quiet: string[] = [];
    const again = delivery((line) => quiet.push(line));
    await again.start();
    await again.idle();
    await again.stop();
    expect(quiet.filter((line) => line.includes("missed"))).toEqual([]);
    await records.close();
  });

  it("compacts a workspace no observer watches, on its tick, and leaves no tick once stopped", async () => {
    const state = stateDir();
    const records = machine.records(state);
    const clock = new ManualClock(Date.now());
    const delivery = new Delivery({
      clock,
      print: () => undefined,
      records,
      retention: DAY,
    });
    await delivery.start();
    await delivery.idle();
    await record(state, ["a", "b", "c"], clock.now());

    clock.advance(LONG_AFTER);
    await delivery.idle();
    expect(await machine.changes(state)).toEqual([]);
    expect(await records.log.head()).toBe(3);

    await delivery.stop();
    expect(clock.ticking).toBe(0);
    expect(clock.waiting).toBe(0);
    await records.close();
  });

  it("starts an observer declared after a compaction no observer held back at a position that still exists", async () => {
    const state = stateDir();
    const records = machine.records(state);
    const clock = new ManualClock(Date.now());
    const lines: string[] = [];
    const unwatched = new Delivery({
      clock,
      print: () => undefined,
      records,
      retention: DAY,
    });
    await unwatched.start();
    await record(state, ["old 1", "old 2"], clock.now());
    clock.advance(LONG_AFTER);
    await unwatched.idle();
    await unwatched.stop();
    expect(await machine.changes(state)).toEqual([]);

    const seen: string[] = [];
    const watched = new Delivery({
      clock,
      print: (line) => lines.push(line),
      records,
      retention: DAY,
    });
    watched.observe(
      TASKS,
      (handed: Fact) => {
        seen.push(handed.id);
      },
      { name: "later" }
    );
    await watched.start();
    await record(state, ["new"], clock.now());
    watched.wake();
    await watched.idle();
    await watched.stop();
    expect(seen).toEqual(["new"]);
    expect(lines.filter((line) => line.includes("missed"))).toEqual([]);
    expect((await records.log.observers())[0]).toMatchObject({
      missed: null,
      position: 3,
    });
    await records.close();
  });

  it("starts no one-second work with no observer: one compaction interval, no counter read per poll, nothing printed", async () => {
    const state = stateDir();
    const records = machine.records(state);
    let heads = 0;
    const log: WorkspaceRecords["log"] = {
      ...logOf(records),
      head: () => {
        heads += 1;
        return records.log.head();
      },
    };
    const clock = new ManualClock(Date.now());
    const lines: string[] = [];
    const delivery = new Delivery({
      clock,
      print: (line) => lines.push(line),
      records: { ...delegate(records), log },
      retention: DAY,
    });
    await delivery.start();
    await delivery.idle();
    expect(clock.periods).toEqual([10 * 60 * 1000]);
    for (let tick = 0; tick < 5; tick += 1) {
      clock.advance(DELIVERY_POLL_MS);
      await delivery.idle();
    }
    expect(heads).toBe(0);
    expect(lines).toEqual([]);
    await delivery.stop();
    expect(clock.periods).toEqual([]);
    await records.close();
  });

  it("starts though compaction fails, tries again on its next interval, and says so once", async () => {
    const records = new MemoryWorkspaceRecords();
    let tries = 0;
    const log: WorkspaceRecords["log"] = {
      ...records.log,
      compact: () => {
        tries += 1;
        return Promise.reject(new Error("the database is busy"));
      },
    };
    const clock = new ManualClock();
    const lines: string[] = [];
    const delivery = new Delivery({
      clock,
      print: (line) => lines.push(line),
      records: { ...delegate(records), log },
    });
    await delivery.start();
    await delivery.idle();
    clock.advance(10 * 60 * 1000);
    await delivery.idle();
    clock.advance(10 * 60 * 1000);
    await delivery.idle();
    await delivery.stop();
    expect(tries).toBe(3);
    expect(lines).toEqual([
      "[observe] compaction: Error: the database is busy",
    ]);
  });

  it("compacts a large old log in bounded steps, a write and a stop between them, and tells an observer exactly what it missed, once", async () => {
    const state = stateDir();
    const records = machine.records(state);
    const clock = new ManualClock(Date.now());
    const seen: string[] = [];
    const lines: string[] = [];
    const observing = () => {
      const built = new Delivery({
        clock,
        print: (line) => lines.push(line),
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
    const first = observing();
    await first.start();
    await first.stop();
    await record(
      state,
      Array.from({ length: 25 }, (_, index) => `old ${String(index + 1)}`),
      clock.now()
    );
    clock.advance(LONG_AFTER);

    let steps = 0;
    let stopping: Promise<void> | undefined;
    const compactor: Delivery = new Delivery({
      clock,
      compactionStep: 10,
      print: (line) => lines.push(line),
      records: {
        ...delegate(records),
        log: {
          ...logOf(records),
          compact: async (bound) => {
            const step = await records.log.compact(bound);
            steps += 1;
            expect(step.removed).toBeLessThanOrEqual(10);
            if (steps === 1) {
              await record(state, ["written"], clock.now());
            }
            if (steps === 2) {
              stopping = compactor.stop();
            }
            return step;
          },
        },
      },
      retention: DAY,
    });
    await compactor.start();
    await compactor.idle();
    await stopping;
    expect(steps).toBe(2);
    expect(
      (await machine.changes(state)).map((change) => change.position)
    ).toEqual([21, 22, 23, 24, 25, 26]);

    const back = observing();
    await back.start();
    await back.idle();
    back.wake();
    await back.idle();
    await back.stop();
    expect(seen).toEqual([
      "old 21",
      "old 22",
      "old 23",
      "old 24",
      "old 25",
      "written",
    ]);
    expect(lines.filter((line) => line.includes("missed"))).toEqual([
      "[observe] absent (tasks) missed changes 1 to 20: they were removed before it received them; it goes on after them",
    ]);
    expect((await records.log.observers())[0]).toMatchObject({
      missed: { from: 1, through: 20 },
      position: 26,
    });
    await records.close();
  });

  it("records what a compaction landing in the middle of a catch-up removed, in the move that passes it", async () => {
    const state = stateDir();
    const records = machine.records(state);
    const clock = new ManualClock(Date.now());
    const lines: string[] = [];
    const seen: string[] = [];
    let compactions = 0;
    const log: WorkspaceRecords["log"] = {
      ...logOf(records),
      read: async (query) => {
        if (compactions === 0) {
          compactions += 1;
          await records.log.compact({
            before: clock.now() + 1,
            now: clock.now(),
            registered: [],
            seenSince: clock.now() + 1,
          });
        }
        return records.log.read(query);
      },
    };
    const delivery = new Delivery({
      clock,
      print: (line) => lines.push(line),
      records: { ...delegate(records), log },
    });
    delivery.observe(
      TASKS,
      (handed: Fact) => {
        seen.push(handed.id);
      },
      { name: "racing" }
    );
    await delivery.start();
    await delivery.idle();
    await record(state, ["a", "b"], clock.now());
    delivery.wake();
    await delivery.idle();
    await delivery.stop();

    expect(compactions).toBe(1);
    expect(seen).toEqual([]);
    expect(lines.filter((line) => line.includes("missed"))).toEqual([
      "[observe] racing (tasks) missed changes 1 to 2: they were removed before it received them; it goes on after them",
    ]);
    expect((await records.log.observers())[0]).toMatchObject({
      missed: { from: 1, through: 2 },
      position: 2,
    });
    await records.close();
  });
});

describe("the delivery timer", () => {
  it.each([
    ["with an observer", true],
    ["with none", false],
  ])("does not keep a process alive, %s", async (_case, observed) => {
    const dir = stateDir();
    const script = join(dir, "never-stopped.ts");
    writeFileSync(
      script,
      `import { Delivery } from ${JSON.stringify(resolvePath("src/lib/events/delivery.ts"))};
import { MemoryWorkspaceRecords } from ${JSON.stringify(resolvePath("src/lib/events/records.ts"))};
import { TASKS } from ${JSON.stringify(resolvePath("src/lib/events/source.ts"))};
const delivery = new Delivery({ print: () => undefined, records: new MemoryWorkspaceRecords() });
${observed ? 'delivery.observe(TASKS, () => undefined, { name: "idle" });' : ""}
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

  it("holds no delivery claim, from its start to its dispose, with no observer", async () => {
    const state = stateDir();
    const engine = engineWith(state, {});
    await engine.start();
    const other = machine.records(state);
    expect(await other.claimDelivery()).toBeUndefined();
    await other.releaseDelivery();
    await shutDown(engine);
    expect(await other.claimDelivery()).toBeUndefined();
    await other.close();
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
    const clock = new ManualClock();
    const delivery = new Delivery({ clock, print: () => undefined, records });
    delivery.observe(TASKS, () => undefined, { name: "idle" });
    const starting = delivery.start();
    await delivery.stop();
    grant(undefined);
    await starting;
    expect(released).toBe(1);
    clock.advance(DELIVERY_POLL_MS);
    clock.advance(DELIVERY_POLL_MS);
    await delivery.idle();
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
    const clock = new ManualClock();
    const delivery = new Delivery({ clock, print: () => undefined, records });
    delivery.observe(TASKS, () => undefined, { name: "idle" });
    const starting = delivery.start();
    await entered;
    await delivery.stop();
    file();
    await starting;
    delivery.wake();
    clock.advance(DELIVERY_POLL_MS);
    clock.advance(DELIVERY_POLL_MS);
    await delivery.idle();
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
    const clock = new ManualClock();
    const delivery = new Delivery({ clock, print: () => undefined, records });
    delivery.observe(TASKS, () => undefined, { name: "idle" });
    await delivery.start();
    await delivery.idle();
    const started = reads;
    clock.advance(DELIVERY_POLL_MS);
    await delivery.idle();
    clock.advance(DELIVERY_POLL_MS);
    await delivery.idle();
    expect(reads).toBe(started + 2);
    await delivery.stop();
    clock.advance(DELIVERY_POLL_MS);
    clock.advance(DELIVERY_POLL_MS);
    clock.advance(DELIVERY_POLL_MS);
    await delivery.idle();
    expect(reads).toBe(started + 2);
  });
});

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

it("compacts a memory log that retains more changes than a call takes arguments", async () => {
  const log = new MemoryChangeLog();
  const change = {
    fact: { at: "", id: "change", type: "changed" },
    recordedAt: 0,
    runId: null,
    source: "tasks",
  };
  const retained = 1_100_000;
  log.record(Array.from({ length: retained + 2 }, () => change));
  expect(
    await log.compact({
      before: 1,
      limit: 2,
      now: 1,
      registered: [],
      seenSince: 1,
    })
  ).toEqual({ done: false, removed: 2 });
  const [next] = await log.read({ after: 0, limit: 1, source: "tasks" });
  expect(next?.position).toBe(3);
});
