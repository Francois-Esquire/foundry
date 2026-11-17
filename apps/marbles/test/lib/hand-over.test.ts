import {
  type ProcessIdentity,
  thisProcess,
} from "@foundry/lib/process-identity";
import { describe, expect, it, vi } from "vitest";
import type { ExecutionView } from "~/lib/execution-store";
import { MemoryExecutionStore } from "~/lib/execution-store";
import { Executions } from "~/lib/executions";
import { Launcher } from "~/lib/launcher";
import { exitedPid } from "../helpers/executions";

class GatedStore extends MemoryExecutionStore {
  holding = false;
  skip = 0;
  counting = false;
  failing: (index: number) => boolean = () => false;
  #index = 0;
  readonly entered = Promise.withResolvers<void>();
  readonly gate = Promise.withResolvers<void>();

  override async transaction<T>(
    work: (view: ExecutionView) => Promise<T>
  ): Promise<T> {
    // biome-ignore lint/suspicious/noUnnecessaryConditions: the test sets it before the handover it gates.
    if (this.holding && this.skip > 0) {
      this.skip -= 1;
      // biome-ignore lint/suspicious/noUnnecessaryConditions: the test sets it before the handover it gates.
    } else if (this.holding) {
      this.holding = false;
      this.entered.resolve();
      await this.gate.promise;
    }
    // biome-ignore lint/suspicious/noUnnecessaryConditions: the test sets it before the writes it counts.
    if (this.counting) {
      const index = this.#index;
      this.#index += 1;
      if (this.failing(index)) {
        throw new Error("injected handover write failure");
      }
    }
    return await super.transaction(work);
  }
}

function launcherOver(store: GatedStore, lines: string[] = []) {
  const executions = new Executions({ store, warn: () => undefined });
  const launcher = new Launcher({
    agents: () => ({}) as never,
    executions,
    print: (line) => lines.push(line),
    recoverQueued: false,
    sandbox: () => ({}) as never,
    workflows: {
      cancel: () => Promise.resolve(),
      dispatch: () => Promise.reject(new Error("no workflows here")),
      has: () => false,
    },
  });
  return { executions, launcher };
}

async function queuedBehindOne(lines: string[] = []) {
  const store = new GatedStore();
  const { executions, launcher } = launcherOver(store, lines);
  await executions.load();
  const started: string[] = [];
  const finish = Promise.withResolvers<void>();
  launcher.task({
    name: "first",
    run: async () => {
      started.push("first");
      await finish.promise;
    },
  });
  launcher.task({
    name: "waiting",
    run: (input) => {
      started.push(String((input as { n: number }).n));
    },
  });
  const first = await launcher.launch("first", {}, {});
  first.result.catch(() => undefined);
  const second = await launcher.launch("waiting", { n: 2 }, {});
  const third = await launcher.launch("waiting", { n: 3 }, {});
  second.result.catch(() => undefined);
  third.result.catch(() => undefined);
  const successor = { pid: thisProcess().pid + 1, started: null };
  const end = async () => {
    finish.resolve();
    await first.result;
  };
  return {
    end,
    executions,
    first,
    launcher,
    second,
    started,
    store,
    successor,
    third,
  };
}

async function settledYet(promise: Promise<unknown>): Promise<string> {
  const pending = Symbol("pending");
  const settled = await Promise.race([
    promise.then(
      () => "resolved",
      () => "rejected"
    ),
    new Promise<symbol>((resolve) => setImmediate(() => resolve(pending))),
  ]);
  return settled === pending ? "pending" : String(settled);
}

describe("an engine that has begun to retire", () => {
  it("refuses a launch that reaches it while it hands its queue over, and one after, as moving to the next engine", async () => {
    const queued = await queuedBehindOne();
    queued.store.holding = true;
    const handing = queued.launcher.handOver(queued.successor);
    await queued.store.entered.promise;
    const during = queued.launcher.launch("waiting", { n: 4 }, {});
    queued.executions.release(queued.first.id);
    queued.store.gate.resolve();
    await expect(during).rejects.toMatchObject({
      name: "EngineRetiringError",
    });
    await handing;
    const after = queued.launcher.launch("waiting", { n: 5 }, {});
    await expect(after).rejects.toMatchObject({ name: "EngineRetiringError" });
    await queued.end();
    expect(queued.started).toEqual(["first"]);
    expect(queued.executions.waiting()).toEqual([]);
    expect(
      queued.executions
        .list()
        .map((run) => (run.input as { n?: number } | undefined)?.n)
    ).not.toContain(4);
  });

  it("hands over without waiting on a launch admitted before it began whose start is still being written", async () => {
    const store = new GatedStore();
    const { executions, launcher } = launcherOver(store);
    await executions.load();
    launcher.task({ name: "quick", run: () => undefined });
    store.skip = 1;
    store.holding = true;
    const launching = launcher.launch("quick", {}, {});
    await store.entered.promise;
    const handing = launcher.handOver({
      pid: thisProcess().pid + 1,
      started: null,
    });
    setTimeout(() => store.gate.resolve(), 20);
    expect(await handing).toEqual([]);
    await (await launching).result;
  });

  it("keeps a run whose hand-over failed queued and unstarted, and hands it over on the next try", async () => {
    const lines: string[] = [];
    const queued = await queuedBehindOne(lines);
    queued.store.holding = true;
    const handing = queued.launcher.handOver(queued.successor);
    await queued.store.entered.promise;
    queued.store.counting = true;
    queued.store.failing = (index) => index === 0;
    queued.executions.release(queued.first.id);
    queued.store.gate.resolve();
    expect(await handing).toEqual([queued.third.id]);
    await expect(queued.second.result).rejects.toThrow(
      "was handed to the next engine generation"
    );
    await queued.end();
    expect(queued.started).toEqual(["first"]);
    for (const run of [queued.second, queued.third]) {
      expect(queued.executions.get(run.id)?.owner).toMatchObject({
        pid: queued.successor.pid,
      });
    }
    expect(
      lines.some((line) => line.includes("injected handover write failure"))
    ).toBe(true);
  });

  it("tells each caller as its run is handed over, and keeps one it cannot hand over queued, unstarted and undrained until it can", async () => {
    const lines: string[] = [];
    const queued = await queuedBehindOne(lines);
    queued.store.holding = true;
    const late: string[] = [];
    const handing = queued.launcher.handOver(queued.successor, (id) =>
      late.push(id)
    );
    await queued.store.entered.promise;
    queued.store.counting = true;
    queued.store.failing = (index) => index > 0;
    queued.executions.release(queued.first.id);
    queued.store.gate.resolve();
    const handed = await handing;

    expect(queued.started).toEqual(["first"]);
    expect(handed).toEqual([queued.second.id]);
    await expect(queued.second.result).rejects.toThrow(
      "was handed to the next engine generation"
    );
    expect(queued.executions.get(queued.third.id)).toMatchObject({
      status: "queued",
    });
    expect(queued.executions.waiting()).toEqual([queued.third.id]);
    expect(await settledYet(queued.third.result)).toBe("pending");
    expect(await settledYet(queued.executions.drained())).toBe("pending");

    await vi.waitFor(
      () =>
        expect(
          lines.filter((line) =>
            line.includes("injected handover write failure")
          ).length
        ).toBe(1),
      { timeout: 5000 }
    );
    queued.store.counting = false;
    await expect(queued.third.result).rejects.toThrow(
      "was handed to the next engine generation"
    );
    expect(late).toEqual([queued.third.id]);
    expect(queued.executions.waiting()).toEqual([]);
    expect(queued.executions.get(queued.third.id)?.owner).toMatchObject({
      pid: queued.successor.pid,
    });
    await queued.end();
    expect(queued.started).toEqual(["first"]);
    expect(
      lines.filter((line) => line.includes("injected handover write failure"))
    ).toHaveLength(1);
  }, 60_000);

  it("keeps handing over a run it could not hand over while the engine stops, so the stop drains", async () => {
    const queued = await queuedBehindOne();
    queued.store.holding = true;
    const handing = queued.launcher.handOver(queued.successor);
    await queued.store.entered.promise;
    queued.store.counting = true;
    queued.store.failing = (index) => index > 0;
    queued.executions.release(queued.first.id);
    queued.store.gate.resolve();
    expect(await handing).toEqual([queued.second.id]);
    expect(queued.executions.waiting()).toEqual([queued.third.id]);
    await queued.launcher.halt(false);
    queued.store.counting = false;
    await vi.waitFor(() => expect(queued.executions.waiting()).toEqual([]), {
      timeout: 5000,
    });
    await expect(queued.third.result).rejects.toThrow(
      "was handed to the next engine generation"
    );
    await queued.end();
    await queued.executions.drained();
    expect(queued.started).toEqual(["first"]);
  }, 60_000);
});

class CurrentStore extends GatedStore {
  current: ProcessIdentity | undefined;

  override transaction<T>(
    work: (view: ExecutionView) => Promise<T>
  ): Promise<T> {
    return super.transaction((view) =>
      work(
        new Proxy(view, {
          get: (target, key) => {
            if (key === "successor") {
              return () => Promise.resolve(this.current);
            }
            const value: unknown = Reflect.get(target, key, target);
            return typeof value === "function" ? value.bind(target) : value;
          },
        })
      )
    );
  }
}

describe("a later pass of a retiring engine's hand-over", () => {
  it("hands a run to the engine current when the write is made, read in its transaction", async () => {
    vi.useFakeTimers();
    try {
      const store = new CurrentStore();
      const { executions, launcher } = launcherOver(store);
      await executions.load();
      launcher.task({ name: "waiting", run: () => undefined });
      launcher.task({
        name: "first",
        run: () => new Promise(() => undefined),
      });
      (await launcher.launch("first", {}, {})).result.catch(() => undefined);
      const queued = await launcher.launch("waiting", {}, {});
      queued.result.catch(() => undefined);
      const retiredFor = { pid: thisProcess().pid + 1, started: null };
      store.counting = true;
      store.failing = () => true;
      await launcher.handOver(retiredFor);
      store.counting = false;
      store.current = retiredFor;
      store.holding = true;
      const pass = vi.advanceTimersByTimeAsync(1000);
      await store.entered.promise;
      const now = { pid: thisProcess().pid + 2, started: null };
      store.current = now;
      store.gate.resolve();
      await pass;
      expect(executions.get(queued.id)?.owner).toMatchObject({
        pid: now.pid,
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("waits while no engine is current, then hands it to the one that is", async () => {
    vi.useFakeTimers();
    try {
      const store = new CurrentStore();
      const { executions, launcher } = launcherOver(store);
      await executions.load();
      launcher.task({ name: "waiting", run: () => undefined });
      launcher.task({
        name: "first",
        run: () => new Promise(() => undefined),
      });
      (await launcher.launch("first", {}, {})).result.catch(() => undefined);
      const queued = await launcher.launch("waiting", {}, {});
      queued.result.catch(() => undefined);
      store.counting = true;
      store.failing = () => true;
      await launcher.handOver({ pid: thisProcess().pid + 1, started: null });
      store.counting = false;
      store.current = undefined;
      await vi.advanceTimersByTimeAsync(1000);
      expect(executions.get(queued.id)?.owner).toMatchObject({
        pid: thisProcess().pid,
      });
      const now = { pid: thisProcess().pid + 2, started: null };
      store.current = now;
      await vi.advanceTimersByTimeAsync(2000);
      expect(executions.get(queued.id)?.owner).toMatchObject({
        pid: now.pid,
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("takes up a run handed to this engine after its first pass, and hands it on", async () => {
    vi.useFakeTimers();
    try {
      const store = new CurrentStore();
      const { executions, launcher } = launcherOver(store);
      await executions.load();
      launcher.task({ name: "waiting", run: () => undefined });
      const now = { pid: thisProcess().pid + 2, started: null };
      store.current = now;
      expect(
        await launcher.handOver({ pid: thisProcess().pid + 1, started: null })
      ).toEqual([]);
      const at = new Date().toISOString();
      await store.create({
        correlation: {},
        id: "rn-handed-late",
        input: {},
        kind: "task",
        name: "waiting",
        observations: [],
        owner: thisProcess(),
        queue: "marbles",
        revision: 1,
        sequence: 99,
        status: "queued",
        timestamps: { queuedAt: at, updatedAt: at },
      });
      await vi.advanceTimersByTimeAsync(2000);
      expect((await executions.peek("rn-handed-late"))?.owner).toMatchObject({
        pid: now.pid,
      });
    } finally {
      vi.useRealTimers();
    }
  });
});

it("hands on, at its next pass, a gone process's queued run it took just as it began to retire", async () => {
  vi.useFakeTimers();
  try {
    const store = new GatedStore();
    const { executions, launcher } = launcherOver(store);
    await executions.load();
    const started: string[] = [];
    launcher.task({
      name: "waiting",
      run: () => {
        started.push("waiting");
      },
    });
    const dead = { pid: exitedPid(), started: null };
    const at = new Date().toISOString();
    await store.create({
      correlation: {},
      id: "rn-orphaned",
      input: {},
      kind: "task",
      name: "waiting",
      observations: [],
      owner: dead,
      queue: "marbles",
      revision: 1,
      sequence: 1,
      status: "queued",
      timestamps: { queuedAt: at, updatedAt: at },
    });
    store.holding = true;
    const taking = launcher.takeOrphaned("rn-orphaned", dead);
    await store.entered.promise;
    const next = { pid: thisProcess().pid + 1, started: null };
    expect(await launcher.handOver(next)).toEqual([]);
    store.gate.resolve();
    expect(await taking).toEqual({ taken: true });
    expect(executions.waiting()).toEqual(["rn-orphaned"]);
    await vi.advanceTimersByTimeAsync(2000);
    expect(executions.get("rn-orphaned")?.owner).toMatchObject({
      pid: next.pid,
    });
    expect(started).toEqual([]);
  } finally {
    vi.useRealTimers();
  }
});

describe("handing queued runs over", () => {
  it("starts none of them here when a slot frees while one is being handed over", async () => {
    const store = new GatedStore();
    const { executions, launcher } = launcherOver(store);
    await executions.load();
    const started: string[] = [];
    const finish = Promise.withResolvers<void>();
    launcher.task({
      name: "first",
      run: async () => {
        started.push("first");
        await finish.promise;
      },
    });
    launcher.task({
      name: "waiting",
      run: (input) => {
        started.push(String((input as { n: number }).n));
      },
    });
    const first = await launcher.launch("first", {}, {});
    first.result.catch(() => undefined);
    const second = await launcher.launch("waiting", { n: 2 }, {});
    const third = await launcher.launch("waiting", { n: 3 }, {});
    second.result.catch(() => undefined);
    third.result.catch(() => undefined);
    expect(started).toEqual(["first"]);

    const successor = { pid: thisProcess().pid + 1, started: null };
    store.holding = true;
    const handing = launcher.handOver(successor);
    await store.entered.promise;
    executions.release(first.id);
    store.gate.resolve();
    const handed = await handing;
    finish.resolve();
    await first.result;

    expect(started).toEqual(["first"]);
    expect([...handed].sort()).toEqual([second.id, third.id].sort());
    for (const run of [second, third]) {
      expect(executions.get(run.id)?.owner).toMatchObject({
        pid: successor.pid,
      });
    }
  });
});
