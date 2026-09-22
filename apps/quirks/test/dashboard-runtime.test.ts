import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { schedule, step, workflow } from "@foundry/quirks";
import { afterEach, expect, it } from "vitest";
import { dashboardSnapshot } from "~/dashboard/snapshot";
import { startEngine } from "~/engine";
import { registry } from "~/lib/registry";
import { bindRuntime } from "~/runtime";
import { tick } from "~/schedule";

const print = () => undefined;
const options = {
  harnesses: [],
  lastFinish: new Map<string, number>(),
  root: "/tmp/workspace",
  startedAt: 1000,
  status: "Ready",
};
const register: Parameters<typeof startEngine>[0] = (orchestrator) => {
  for (const definition of registry.definitions.values()) {
    definition(orchestrator);
  }
};
afterEach(() => registry.reset());

it("projects real nested runs, logs and trigger provenance, including restored history", async () => {
  const dir = mkdtempSync(join(tmpdir(), "quirks-dashboard-"));
  const runtime = bindRuntime({ dry: true, only: [], print, root: dir });
  const shout = step("shout", ({ log }, input: string) => {
    log(`heard ${input}`);
    return Promise.resolve(input.toUpperCase());
  });
  workflow<string, string>("twice", (graph) => {
    graph
      .step("first", shout, ({ input }) => input)
      .step("second", shout, ({ first }) => `${first}!`)
      .output(({ second }) => second);
  });
  schedule("hourly", { at: "1h", input: "hi", workflow: "twice" });
  schedule("daily", { at: "1d", input: "other", workflow: "twice" });
  let engine = await startEngine(register, { print, state: dir });
  try {
    const scheduled = registry.schedules.get("hourly");
    if (!scheduled) {
      throw new Error("missing fixture schedule");
    }
    await tick(engine, scheduled, { print, state: dir });
    const snapshot = dashboardSnapshot(await engine.runs(), options);
    expect(snapshot.mode).toBe("live");
    expect(snapshot.definitions).toEqual([
      {
        description: "Registered step",
        id: "shout",
        kind: "step",
        name: "shout",
      },
      {
        description: "Registered workflow",
        id: "twice",
        kind: "workflow",
        name: "twice",
      },
    ]);
    expect(snapshot.runs[0]).toMatchObject({
      definitionId: "twice",
      input: "hi",
      result: "HI!",
      status: "complete",
      triggerId: "hourly",
    });
    expect(snapshot.runs[0]?.steps[0]?.children).toMatchObject([
      { name: "first", result: "HI", status: "complete" },
      { name: "second", result: "HI!", status: "complete" },
    ]);
    expect(snapshot.runs[0]?.logs?.map((entry) => entry.message)).toEqual([
      "heard hi",
      "heard HI!",
    ]);
    await engine.stop();
    engine = await startEngine(register, { print, state: dir });
    const restored = dashboardSnapshot(await engine.runs(), options);
    expect(restored.runs).toEqual(snapshot.runs);
  } finally {
    await engine.stop();
    await runtime.dispose();
    rmSync(dir, { force: true, recursive: true });
  }
});

it("shows a running step and cancels it on shutdown without starting queued work", async () => {
  const runtime = bindRuntime({
    dry: true,
    only: [],
    print,
    root: process.cwd(),
  });
  let announce: () => void = () => undefined;
  const started = new Promise<void>((resolve) => {
    announce = resolve;
  });
  let calls = 0;
  let aborted = false;
  step(
    "wait",
    ({ signal, log }) =>
      new Promise<void>((resolve) => {
        calls += 1;
        log("waiting");
        signal?.addEventListener(
          "abort",
          () => {
            aborted = true;
            resolve();
          },
          { once: true }
        );
        announce();
      })
  );
  const engine = await startEngine(register, { print });
  try {
    const running = engine.run("wait", null, "watch");
    const result = running.catch((error: unknown) => error);
    await started;
    const queued = engine
      .run("wait", null, "other")
      .catch((error: unknown) => error);
    const snapshot = dashboardSnapshot(await engine.runs(), options);
    expect(
      snapshot.runs.find((run) => run.triggerId === "watch")?.steps[0]?.status
    ).toBe("running");
    await engine.stop({ cancel: true });
    expect(await result).toBeInstanceOf(Error);
    expect(await queued).toBeInstanceOf(Error);
    expect(aborted).toBe(true);
    expect(calls).toBe(1);
    expect(
      (await engine.runs()).every((run) => run.status === "cancelled")
    ).toBe(true);
    await expect(engine.run("wait", null)).rejects.toThrow(
      "engine is stopping"
    );
  } finally {
    await runtime.dispose();
  }
});
