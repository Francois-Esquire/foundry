/**
 * The edges of a run's life in one process: a stop racing a task that gives
 * up its slot or a dispatch waiting on one, a cancel sent from the very
 * lifecycle update that announces a run, and a dispatch withdrawn after its
 * factory has built the run's tree.
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Workflow } from "@foundry/workflows/workflow";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { z } from "zod";
import { step } from "~/authoring/builder";
import { catalog } from "~/authoring/catalog";
import type { Engine } from "~/lib/engine";
import type { ExecutionRun } from "~/lib/executions";
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

/** Waits for the signal, as a long-lived task does. */
function aborted(signal: AbortSignal): Promise<void> {
  return new Promise((resolve) =>
    signal.addEventListener("abort", () => resolve(), { once: true })
  );
}

it("stops a task that gives up its slot after the stop began", async () => {
  const engine = engineWith();
  const { promise: begun, resolve: begin } = Promise.withResolvers<void>();
  const { promise: free, resolve: release } = Promise.withResolvers<void>();
  engine.task({
    name: "late",
    run: async (_input: unknown, { release: giveUp, signal }: TaskContext) => {
      begin();
      await free;
      giveUp();
      await aborted(signal);
    },
  });
  await engine.start();
  const launched = await engine.launch("late", {});
  await begun;

  const stopping = engine.stop();
  // The stop has scanned for released tasks; this one releases only now.
  await new Promise((resolve) => setTimeout(resolve, 20));
  release();

  await stopping;
  await expect(launched.result).rejects.toThrow();
  expect(engine.executions.get(launched.id)?.status).toBe("cancelled");
});

it("stops a released task before waiting on a dispatch that needs what it holds", async () => {
  const engine = engineWith();
  const { promise: held, resolve: freeHeld } = Promise.withResolvers<void>();
  engine.task({
    name: "holder",
    queue: "programs",
    run: async (_input: unknown, { release, signal }: TaskContext) => {
      release();
      await aborted(signal);
      // Only its stop gives the resource back.
      freeHeld();
    },
  });
  engine.register<unknown, string>("needs", async (input) => {
    await held;
    return Workflow.create({
      execute: () => Promise.resolve("done"),
      input,
      name: "needs",
    });
  });
  await engine.start();
  const holder = await engine.launch("holder", {});
  await vi.waitFor(() =>
    expect(engine.executions.get(holder.id)?.status).toBe("running")
  );
  // The factory waits on the holder, so its launch is not awaited.
  const needs = engine.launch<string>("needs", {});

  await engine.stop();

  expect(engine.executions.get(holder.id)?.status).toBe("cancelled");
  const { result } = await needs;
  await expect(result).resolves.toBe("done");
});

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
    const subscription = engine.executions.subscribe((run) => {
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

it("never dispatches a workflow a subscriber cancels on its running update", async () => {
  let ran = false;
  step("flow").do(() => {
    ran = true;
    return "ran";
  });
  const engine = engineWith();
  await engine.start();
  let cancelled: Promise<void> | undefined;
  const subscription = engine.executions.subscribe((run) => {
    if (run.name === "flow" && run.status === "running" && !cancelled) {
      cancelled = engine.cancel(run.id);
    }
  });

  const launched = await engine.launch("flow", {});
  await expect(launched.result).rejects.toThrow(CANCELLED);
  await cancelled;
  subscription.unsubscribe();

  expect(ran).toBe(false);
  expect(engine.executions.get(launched.id)?.status).toBe("cancelled");
  expect(engine.scopes.has(launched.id)).toBe(false);
});

it("closes the scope a factory built when its dispatch is withdrawn", async () => {
  let engine!: Engine;
  let id = "";
  let cancelling: Promise<void> | undefined;
  step("leak")
    .input(
      z.string().transform((value) => {
        cancelling = engine.cancel(id);
        return value;
      })
    )
    .do(({ input }) => input);
  engine = engineWith();
  await engine.start();
  const subscription = engine.executions.subscribe((run: ExecutionRun) => {
    if (run.name === "leak" && run.status === "running") {
      ({ id } = run);
    }
  });

  const launched = await engine.launch("leak", "x");
  await expect(launched.result).rejects.toThrow(CANCELLED);
  await cancelling;
  subscription.unsubscribe();

  expect(engine.executions.get(id)?.status).toBe("cancelled");
  expect(engine.scopes.has(id)).toBe(false);
});

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
