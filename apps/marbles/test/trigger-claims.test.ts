/**
 * Two engines over one Marbles database tick the same trigger: what a tick
 * decides on (whether it is still due, whether a monitor has a launch to
 * start) is read once its claim is held, so a tick that finished between
 * another's look and its claim is never repeated, and a monitor's pending
 * launch is started once.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import type { MarblesDatabase } from "~/database/open";
import { initializeDatabase } from "~/database/open";
import { DatabaseTriggerStore } from "~/database/triggers";
import { stateDatabase } from "~/layout";
import type { ScheduledEngine } from "~/lib/schedule";
import { tick } from "~/lib/schedule";
import type { TriggerStore } from "~/lib/trigger-store";
import type { Schedule } from "~/lib/triggers";

const roots: string[] = [];
const handles: MarblesDatabase[] = [];

afterEach(() => {
  for (const handle of handles.splice(0)) {
    handle.close();
  }
  for (const root of roots.splice(0)) {
    rmSync(root, { force: true, recursive: true });
  }
});

async function twoEngines(): Promise<{
  readonly first: DatabaseTriggerStore;
  readonly second: DatabaseTriggerStore;
}> {
  const root = mkdtempSync(join(tmpdir(), "marbles-trigger-claims-"));
  roots.push(root);
  const opened = await initializeDatabase(stateDatabase(root));
  handles.push(opened);
  const { database } = opened;
  return {
    first: new DatabaseTriggerStore({ database, scope: "ws" }),
    second: new DatabaseTriggerStore({ database, scope: "ws" }),
  };
}

/** `triggers`, running `before` ahead of each claim. */
function claimingAfter(
  triggers: TriggerStore,
  before: () => Promise<void>
): TriggerStore {
  return {
    claimTick: async (key) => {
      await before();
      return await triggers.claimTick(key);
    },
    clearPendingLaunch: (key) => triggers.clearPendingLaunch(key),
    close: () => triggers.close(),
    finishTick: (key, history) => triggers.finishTick(key, history),
    lastTick: (key) => triggers.lastTick(key),
    monitorState: (key) => triggers.monitorState(key),
    saveMonitorState: (key, state) => triggers.saveMonitorState(key, state),
  };
}

function engineOver(
  triggers: TriggerStore,
  schedule: Schedule,
  launch: (name: string, input: unknown) => Promise<unknown>
): ScheduledEngine {
  return {
    cancel: () => Promise.resolve(),
    has: () => true,
    launch: async (name: string, input: unknown) => ({
      id: `run-${name}`,
      result: launch(name, input),
    }),
    schedules: () => [schedule],
    triggers,
  } as unknown as ScheduledEngine;
}

const every: Schedule = {
  input: null,
  key: "hourly",
  kind: "schedule",
  label: "hourly",
  trigger: { kind: "interval", ms: 3_600_000 },
  workflow: "flow",
};

it("does not run a tick another engine finished between this one's look and its claim", async () => {
  const { first, second } = await twoEngines();
  const runs: string[] = [];
  const firstEngine = engineOver(first, every, () => {
    runs.push("first");
    return Promise.resolve("done");
  });
  let raced = false;
  const secondEngine = engineOver(
    claimingAfter(second, async () => {
      if (!raced) {
        raced = true;
        await tick(firstEngine, every, {
          now: () => 10_000,
          print: () => undefined,
        });
      }
    }),
    every,
    () => {
      runs.push("second");
      return Promise.resolve("done");
    }
  );

  // The loop found it due; the first engine ticked it before the claim.
  await expect(
    tick(secondEngine, every, {
      now: () => 10_000,
      print: () => undefined,
      scheduled: true,
    })
  ).resolves.toBeUndefined();
  expect(runs).toEqual(["first"]);
});

it("starts a monitor's pending launch once when two engines tick it", async () => {
  const { first, second } = await twoEngines();
  const monitor: Schedule = {
    ...every,
    key: "watch",
    kind: "monitor",
    label: "watch",
    workflow: "watch-detector",
  };
  await first.saveMonitorState("watch", {
    observed: { hash: "a" },
    pending: { input: { task: "a" }, workflow: "ship" },
  });
  const shipped: string[] = [];
  const lines: string[] = [];
  /** The detector as a monitor runs it: a pending launch first, else nothing changed. */
  const detect = async (triggers: TriggerStore) => {
    const kept = await triggers.monitorState("watch");
    return kept?.pending
      ? { changed: true, launch: kept.pending }
      : { changed: false };
  };
  let secondTick: Promise<unknown> | undefined;
  const secondEngine = engineOver(second, monitor, (name) =>
    name === "ship" ? Promise.resolve(shipped.push("second")) : detect(second)
  );
  const firstEngine = engineOver(first, monitor, (name) => {
    if (name !== "ship") {
      return detect(first);
    }
    shipped.push("first");
    // While the first engine is starting the launch, the second ticks.
    secondTick = tick(secondEngine, monitor, {
      print: (line) => lines.push(line),
    });
    return secondTick;
  });

  await tick(firstEngine, monitor, { print: () => undefined });
  expect(await secondTick).toBeUndefined();
  expect(lines).toEqual(["[schedule] watch skipped: held by this process"]);
  // Its launch was started and cleared: the next tick polls.
  await expect(
    tick(secondEngine, monitor, { print: () => undefined })
  ).resolves.toEqual({ value: { changed: false } });
  expect(shipped).toEqual(["first"]);
});
