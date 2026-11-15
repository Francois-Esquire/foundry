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

/** A memory store whose transactions wait at `gate` while `holding` is set. */
class GatedStore extends MemoryExecutionStore {
  holding = false;
  readonly entered = Promise.withResolvers<void>();
  readonly gate = Promise.withResolvers<void>();

  override async transaction<T>(
    work: (view: ExecutionView) => Promise<T>
  ): Promise<T> {
    // biome-ignore lint/suspicious/noUnnecessaryConditions: the test sets it before the handover it gates.
    if (this.holding) {
      this.holding = false;
      this.entered.resolve();
      await this.gate.promise;
    }
    return await super.transaction(work);
  }
}

function launcherOver(store: GatedStore) {
  const executions = new Executions({ store, warn: () => undefined });
  const launcher = new Launcher({
    agents: () => ({}) as never,
    executions,
    print: () => undefined,
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
