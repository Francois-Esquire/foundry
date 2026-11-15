import { thisProcess } from "@foundry/lib/process-identity";
import { describe, expect, it } from "vitest";
import type { ExecutionView } from "~/lib/execution-store";
import { MemoryExecutionStore } from "~/lib/execution-store";
import { Executions } from "~/lib/executions";
import { Launcher } from "~/lib/launcher";

/**
 * A retiring engine handing its queued runs to its successor: nothing of
 * its queue may start here once the handover began, even when a slot frees
 * while a run's handover is being written.
 */

/**
 * A memory store whose transactions wait at `gate` while `holding` is set,
 * and that refuses the transactions `failing` says to, counted from 0 once
 * `counting` is set.
 */
class GatedStore extends MemoryExecutionStore {
  holding = false;
  /** How many transactions pass before the one `holding` gates. */
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

/**
 * A launcher with a task `first` running, holding its queue's one slot,
 * and runs 2 and 3 of `waiting` queued behind it; `started` lists what
 * started here.
 */
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
  /** Let the first run end, and wait for its end. */
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

/** How `promise` has settled by the time everything already due has run. */
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
    // The slot frees while the hand-over is written.
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
    // Nothing of the refused launches was recorded here.
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
    // The launch's record is written; its start is held.
    store.skip = 1;
    store.holding = true;
    const launching = launcher.launch("quick", {}, {});
    await store.entered.promise;
    const handing = launcher.handOver({
      pid: thisProcess().pid + 1,
      started: null,
    });
    // Released from a timer: a hand-over that never yields never sees it.
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
    // The second run's hand-over is refused once.
    queued.store.counting = true;
    queued.store.failing = (index) => index === 0;
    queued.executions.release(queued.first.id);
    queued.store.gate.resolve();
    const handed = await handing;
    await queued.end();
    expect(queued.started).toEqual(["first"]);
    expect([...handed].sort()).toEqual(
      [queued.second.id, queued.third.id].sort()
    );
    for (const run of [queued.second, queued.third]) {
      expect(queued.executions.get(run.id)?.owner).toMatchObject({
        pid: queued.successor.pid,
      });
    }
    expect(
      lines.some((line) => line.includes("injected handover write failure"))
    ).toBe(true);
  });

  it("tells each caller as its run is handed over, and keeps one it cannot hand over queued, unstarted and undrained", async () => {
    const lines: string[] = [];
    const queued = await queuedBehindOne(lines);
    queued.store.holding = true;
    const handing = queued.launcher.handOver(queued.successor);
    await queued.store.entered.promise;
    // The second run moves; every try at the third is refused.
    queued.store.counting = true;
    queued.store.failing = (index) => index > 0;
    queued.executions.release(queued.first.id);
    queued.store.gate.resolve();
    const handed = await handing;
    queued.store.counting = false;
    await queued.end();

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
    expect(
      lines.some(
        (line) =>
          line.includes(queued.third.id) &&
          line.includes("stays queued here, unstarted")
      )
    ).toBe(true);
  });
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
    // While the second run's handover is written, the first run gives up
    // its slot, as a run that parks on a question or a task that lets its
    // slot go does: no write of its own, so nothing waits behind the gate.
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
