import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ArtifactSystem, InMemoryArtifactStore } from "@foundry/artifacts";
import { schedule, step, workflow } from "@foundry/quirks";
import { afterEach, expect, it } from "vitest";
import { z } from "zod";
import { dashboardSnapshot } from "~/dashboard/snapshot";
import { catalog } from "~/lib/catalog";
import { createEngine } from "~/lib/create";
import { runs } from "~/lib/run-scope";
import { tick } from "~/lib/schedule";

const print = () => undefined;
const options = {
  harnesses: [],
  lastFinish: new Map<string, number>(),
  root: "/tmp/workspace",
  startedAt: 1000,
  status: "Ready",
};
const text = z.object({ text: z.string() });
const textFields = [
  { label: "Text", name: "text", required: true, type: "text" },
];

/** A started dry engine over `root`; `state` makes its runs survive a restart. */
function engineIn(root: string, state?: string) {
  return createEngine({
    artifacts: new ArtifactSystem({ store: new InMemoryArtifactStore() }),
    catalog,
    dry: true,
    only: [],
    print,
    root,
    ...(state === undefined ? {} : { state }),
    workspaceId: "ws",
  }).start();
}

afterEach(() => {
  catalog.reset();
  runs.clear();
});

it("projects real nested runs, logs and trigger provenance, including restored history", async () => {
  const dir = mkdtempSync(join(tmpdir(), "quirks-dashboard-"));
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
  schedule(twice({}, { text: "hi" })).every("1h");
  schedule(twice({}, { text: "other" })).every("1d");
  const [hourly, daily] = [...catalog.schedules.keys()] as [string, string];
  let engine = await engineIn(dir, dir);
  try {
    const scheduled = catalog.schedules.get(hourly);
    if (!scheduled) {
      throw new Error("missing fixture schedule");
    }
    await tick(engine, scheduled, { print, state: dir });
    const snapshot = dashboardSnapshot(await engine.runs(), options);
    expect(snapshot.mode).toBe("live");
    // Anonymous `bang` is internal; the schema gives each entry its form.
    expect(snapshot.definitions).toEqual([
      {
        description: "Registered step",
        id: "shout",
        input: { fields: textFields },
        kind: "step",
        name: "shout",
      },
      {
        description: "Registered workflow",
        id: "twice",
        input: { fields: textFields },
        kind: "workflow",
        name: "twice",
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
    engine = await engineIn(dir, dir);
    const restored = dashboardSnapshot(await engine.runs(), options);
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
  step("wait").do(
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
  const engine = await engineIn(process.cwd());
  try {
    const running = engine.run("wait", {}, "watch");
    const result = running.catch((error: unknown) => error);
    await started;
    const queued = engine
      .run("wait", {}, "other")
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
    await expect(engine.run("wait", {})).rejects.toThrow("engine is stopping");
  } finally {
    await engine.dispose();
  }
});
