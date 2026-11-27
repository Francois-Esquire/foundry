import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Catalog, schedule, step, workflow } from "@foundry.sh/marbles";
import { expect, it, vi } from "vitest";
import { z } from "zod";
import { createEngine } from "~/create";
import type { Engine } from "~/lib/engine";
import { runSteps } from "~/lib/run-trace";
import { rollSchedule } from "~/lib/schedule";
import { dashboardSnapshot } from "~/workspace/snapshot";
import { startEngine } from "./helpers/engine";

const print = () => undefined;
const options = {
  root: "/tmp/workspace",
  startedAt: 1000,
  status: "Ready",
};
const text = z.object({ text: z.string() });
const textFields = [
  { label: "Text", name: "text", required: true, type: "text" },
];

function engineIn(root: string, catalog: Catalog, stateDir?: string) {
  return createEngine({
    catalog,
    pools: { default: 1 },
    print,
    root,
    stateDir,
    workspaceId: "ws",
  }).start();
}

async function view(engine: Engine) {
  return {
    ...options,
    definitions: engine.definitions(),
    monitors: engine.monitors(),
    schedules: await engine.schedules(),
  };
}

it("projects real nested runs, logs and trigger provenance, including restored history", async () => {
  const dir = mkdtempSync(join(tmpdir(), "marbles-dashboard-"));
  const shout = step("shout")
    .input(text)
    .do(({ input, log }) => {
      log(`heard ${input.text}`);
      return input.text.toUpperCase();
    });
  const bang = step()
    .input(z.object({ first: z.string() }))
    .do(({ input, log }) => {
      log(`heard ${input.first}!`);
      return `${input.first}!`;
    });
  const twice = workflow("twice")
    .input(text)
    .do(({ input }) => bang({ first: shout({}, input) }));
  const s1 = schedule(twice({}, { text: "hi" })).every("1h");
  const s2 = schedule(twice({}, { text: "other" })).every("1d");
  const collected = Catalog.collect({
    declarations: [shout, twice, s1, s2],
    source: import.meta.filename,
  });
  const [hourly, daily] = [...collected.schedules.keys()] as [string, string];
  let engine = await engineIn(dir, collected, dir);
  try {
    const scheduled = collected.schedules.get(hourly);
    if (!scheduled) {
      throw new Error("missing fixture schedule");
    }
    await rollSchedule(engine, scheduled, { print });
    const snapshot = dashboardSnapshot(await engine.runs(), await view(engine));
    expect(snapshot.mode).toBe("live");
    const declaredHere = {
      external: true,
      source: expect.stringContaining("dashboard-runtime.test.ts"),
    };
    expect(snapshot.definitions).toEqual([
      {
        description: "Registered step",
        id: "shout",
        input: { fields: textFields },
        kind: "step",
        name: "shout",
        origin: declaredHere,
      },
      {
        description: "Registered workflow",
        id: "twice",
        input: { fields: textFields },
        kind: "workflow",
        name: "twice",
        origin: declaredHere,
      },
    ]);
    expect(
      snapshot.triggers.map((trigger) => [trigger.id, trigger.targetId])
    ).toEqual([
      [hourly, "twice"],
      [daily, "twice"],
    ]);
    expect(snapshot.runs[0]).toMatchObject({
      definitionId: "twice",
      input: { text: "hi" },
      result: "HI!",
      status: "complete",
      triggerId: hourly,
    });
    expect(snapshot.runs[0]?.steps).toMatchObject([
      {
        children: [{ name: "first", result: "HI", status: "complete" }],
        name: "twice",
        result: "HI!",
        status: "complete",
      },
    ]);
    expect(snapshot.runs[0]?.logs?.map((entry) => entry.message)).toEqual([
      "heard hi",
      "heard HI!",
    ]);
    await engine.stop();
    await engine.dispose();
    engine = await engineIn(dir, collected, dir);
    const restored = dashboardSnapshot(await engine.runs(), await view(engine));
    expect(restored.runs).toEqual(snapshot.runs);
  } finally {
    await engine.stop();
    await engine.dispose();
    rmSync(dir, { force: true, recursive: true });
  }
});

it("shows a running step and cancels it on shutdown without starting queued work", async () => {
  let announce: () => void = () => undefined;
  const started = new Promise<void>((resolve) => {
    announce = resolve;
  });
  let calls = 0;
  let aborted = false;
  const wait = step("wait").do(
    ({ signal, log }) =>
      new Promise<void>((resolve) => {
        calls += 1;
        log("waiting");
        signal.addEventListener(
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
  const engine = await engineIn(process.cwd(), Catalog.collect([wait]));
  try {
    const running = engine.run("wait", {}, "watch");
    const result = running.catch((error: unknown) => error);
    await started;
    const queued = engine
      .run("wait", {}, "other")
      .catch((error: unknown) => error);
    const snapshot = dashboardSnapshot(await engine.runs(), await view(engine));
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
    await expect(engine.run("wait", {})).rejects.toThrow("engine is stopping");
  } finally {
    await engine.dispose();
  }
});

it("shows a suspended step as cancelled and keeps its completed prerequisite", async () => {
  const prepare = step("prepare").do(() => "draft");
  const askForReview = step("ask-review")
    .input(z.object({ draft: z.string() }))
    .do(({ ask, input }) => ask.question({ title: `Keep ${input.draft}?` }));
  const review = workflow("review").do(() =>
    askForReview({ draft: prepare({}) })
  );

  const engine = await startEngine({
    askable: true,
    collect: [prepare, askForReview, review],
  });
  try {
    const run = await engine.launch("review", {});
    const result = run.result.catch((error: unknown) => error);
    await vi.waitFor(async () => {
      expect((await engine.runs())[0]?.status).toBe("suspended");
    });

    await engine.cancel(run.id);
    expect(await result).toBeInstanceOf(Error);
    const records = await engine.runs();
    const [record] = records;
    if (!record) {
      throw new Error("Expected a cancelled run");
    }
    const steps = [
      {
        children: [{ name: "draft", status: "complete" }],
        name: "review",
        status: "cancelled",
      },
    ];
    expect(runSteps(record)).toMatchObject(steps);
    const snapshot = dashboardSnapshot(records, await view(engine));
    expect(snapshot.runs[0]).toMatchObject({
      id: run.id,
      status: "cancelled",
      steps,
      timing: { endedAt: expect.any(Number), startedAt: expect.any(Number) },
    });
  } finally {
    await engine.dispose();
  }
});
