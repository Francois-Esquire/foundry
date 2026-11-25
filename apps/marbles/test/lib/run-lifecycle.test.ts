import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { catalog } from "~/authoring/catalog";
import type { Engine } from "~/lib/engine";
import type { TaskContext } from "~/lib/tasks";
import { testEngine } from "../helpers/engine";

const CANCELLED = /cancelled/;

let root: string;
const engines: Engine[] = [];

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "marbles-lifecycle-"));
});

afterEach(async () => {
  catalog.reset();
  await Promise.allSettled(engines.splice(0).map((engine) => engine.dispose()));
  await rm(root, { force: true, recursive: true });
});

function engineWith(options: Parameters<typeof testEngine>[0] = {}): Engine {
  const engine = testEngine({ root, ...options });
  engines.push(engine);
  return engine;
}

it.each(["queued", "running"] as const)(
  "never runs a task a subscriber cancels on its %s update",
  async (status) => {
    const engine = engineWith();
    let ran = false;
    engine.task({
      name: "t",
      run: () => {
        ran = true;
        return 1;
      },
    });
    await engine.start();
    let cancelled: Promise<void> | undefined;
    const subscription = await engine.executions.subscribe((run) => {
      if (run.name === "t" && run.status === status && !cancelled) {
        cancelled = engine.cancel(run.id);
      }
    });

    const launched = await engine.launch("t", {});
    await expect(launched.result).rejects.toThrow(CANCELLED);
    await expect(cancelled).resolves.toBeUndefined();
    subscription.unsubscribe();

    expect(ran).toBe(false);
    expect(engine.executions.get(launched.id)?.status).toBe("cancelled");
  }
);

it.each([false, true])(
  "ends resource lifetime without changing the task outcome, failure=%s",
  async (fail) => {
    const engine = engineWith();
    const exec = vi.fn();
    let captured: TaskContext | undefined;
    let sandbox: ReturnType<TaskContext["sandbox"]> | undefined;
    engine.task({
      name: "borrow",
      run: (_input: unknown, context: TaskContext) => {
        captured = context;
        sandbox = context.sandbox({
          commands: { exec },
        } as unknown as Parameters<TaskContext["sandbox"]>[0]);
        if (fail) {
          throw new Error("body failed");
        }
        return "done";
      },
    });
    await engine.start();
    const run = await engine.launch("borrow", {});
    if (fail) {
      await expect(run.result).rejects.toThrow("body failed");
    } else {
      await expect(run.result).resolves.toBe("done");
    }
    expect(engine.executions.get(run.id)?.status).toBe(
      fail ? "failed" : "complete"
    );
    expect(captured?.signal.aborted).toBe(true);
    await expect(sandbox?.exec("late work")).rejects.toThrow(
      "resource lifetime ended"
    );
    expect(exec).not.toHaveBeenCalled();
  }
);
