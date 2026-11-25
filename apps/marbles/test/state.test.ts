import { spawnSync } from "node:child_process";
import {
  mkdirSync,
  readdirSync,
  readFileSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { lockContents } from "@foundry/lib/node/file-lock";
import { Step } from "@foundry/workflows/step";
import { describe, expect, it, vi } from "vitest";
import { defaultWorkspaceTriggers } from "~/database/managed";
import { rollSchedule } from "~/lib/schedule";
import { acquireLock } from "~/lib/state/locks";
import { workspaceState } from "~/lib/state/workspace";
import type { Schedule } from "~/lib/triggers";
import { runStoreEffect } from "~/lib/workflow-runs";
import { testEngine } from "./helpers/engine";
import { occurrencesOf, startScheduler } from "./helpers/schedules";
import { readStoredRuns } from "./helpers/stored-runs";
import { temporaryDirectory } from "./helpers/temporary";

const SHORT_HEX_ID_PATTERN = /^[0-9a-f]{12}$/;
const BOOM_PATTERN = /boom/;

class Shout extends Step<string, string> {
  readonly definitionKey = "test.shout";

  protected execute(input: string): Promise<string> {
    return Promise.resolve(input.toUpperCase());
  }
}

class Quiet extends Step<void, void> {
  readonly definitionKey = "test.quiet";

  protected execute(): Promise<void> {
    return Promise.resolve();
  }
}

class Explode extends Step<void, never> {
  readonly definitionKey = "test.explode";

  protected execute(): Promise<never> {
    return Promise.reject(new Error("boom"));
  }
}

function collector() {
  const lines: string[] = [];
  return { lines, print: (line: string) => lines.push(line) };
}

function engineIn(state: string, print: (line: string) => void) {
  const engine = testEngine({ print, state });
  engine.register("shout", new Shout().factory());
  engine.register("quiet", new Quiet().factory());
  engine.register("explode", new Explode().factory());
  return engine.start();
}

describe("stored runs", () => {
  it("keeps every settled run in the database and lists them across processes", async () => {
    const state = temporaryDirectory("marbles-state-");
    const { lines, print } = collector();

    const first = await engineIn(state, print);
    await first.run<string>("shout", "one");
    await expect(first.run<never>("explode", undefined)).rejects.toThrow();
    await first.dispose();
    expect(await readStoredRuns(state, "test")).toHaveLength(2);

    const second = await engineIn(state, print);
    await second.run<string>("shout", "two");
    const runs = await second.runs();
    await second.dispose();

    expect(runs.map((run) => run.status).sort()).toEqual([
      "complete",
      "complete",
      "failed",
    ]);
    const stored = await readStoredRuns(state, "test");
    expect(stored).toHaveLength(3);
    expect(stored.map((run) => run.owner)).toEqual([null, null, null]);
    expect(lines.filter((line) => line.startsWith("[state]"))).toEqual([]);
  });

  it("survives a run that returns nothing", async () => {
    const state = temporaryDirectory("marbles-state-");
    const { lines, print } = collector();
    const engine = await engineIn(state, print);
    await engine.run<undefined>("quiet", undefined);
    await engine.dispose();
    expect(lines.filter((line) => line.startsWith("[state]"))).toEqual([]);
    expect(await readStoredRuns(state, "test")).toHaveLength(1);
  });

  it("ignores run files an earlier Marbles left in the state dir", async () => {
    const state = temporaryDirectory("marbles-state-");
    mkdirSync(join(state, "runs"));
    writeFileSync(join(state, "runs", "rn-bad.json"), "{ not json");
    writeFileSync(join(state, "runs", "rn-hollow.json"), '{"pid": 1}');
    const { lines, print } = collector();

    const engine = await engineIn(state, print);
    await engine.run<string>("shout", "one");
    const runs = await engine.runs();
    await engine.dispose();

    expect(runs).toHaveLength(1);
    expect(lines.filter((line) => line.startsWith("[state]"))).toEqual([]);
  });
});

describe("workspace", () => {
  it("derives one id per root, and its directory under the state root", () => {
    const state = temporaryDirectory("marbles-state-");
    const a = temporaryDirectory("marbles-ws-a-");
    const b = temporaryDirectory("marbles-ws-b-");

    const first = workspaceState(state, a);
    expect(workspaceState(state, a).id).toBe(first.id);
    expect(workspaceState(state, b).id).not.toBe(first.id);
    expect(first.id).toMatch(SHORT_HEX_ID_PATTERN);
    expect(first.dir).toBe(join(state, first.id));
  });
});

describe("locks", () => {
  it("yields to a live holder and replaces a dead one", () => {
    const state = temporaryDirectory("marbles-state-");
    mkdirSync(join(state, "locks"));

    writeFileSync(join(state, "locks", "s"), String(process.pid));
    expect(acquireLock(state, "s")).toEqual({
      holder: `pid ${String(process.pid)}`,
    });

    const dead = spawnSync("true").pid;
    writeFileSync(join(state, "locks", "s"), String(dead));
    const lock = acquireLock(state, "s");
    expect(lock).toHaveProperty("release");
    expect(readFileSync(join(state, "locks", "s"), "utf8")).toBe(
      lockContents()
    );
    if ("release" in lock) {
      lock.release();
    }
    expect(readdirSync(join(state, "locks"))).toEqual([]);
  });

  it("waits out a lock being taken, and breaks one left empty", () => {
    const state = temporaryDirectory("marbles-state-");
    mkdirSync(join(state, "locks"));
    const path = join(state, "locks", "s");
    writeFileSync(path, "");

    expect(acquireLock(state, "s")).toEqual({
      holder: "a process that is taking it now; retry",
    });
    expect(readFileSync(path, "utf8")).toBe("");

    const old = new Date(Date.now() - 60_000);
    utimesSync(path, old, old);
    expect(acquireLock(state, "s")).toHaveProperty("release");
    expect(readFileSync(path, "utf8")).toBe(lockContents());
  });

  it("never breaks a lock that is not a pid, and says how to clear it", () => {
    const state = temporaryDirectory("marbles-state-");
    mkdirSync(join(state, "locks"));
    const path = join(state, "locks", "s");
    writeFileSync(path, "by hand");

    expect(acquireLock(state, "s")).toEqual({
      holder: `an unknown process (if none is running, remove ${path})`,
    });
    expect(readFileSync(path, "utf8")).toBe("by hand");
  });

  it("releases only a lock it still holds", () => {
    const state = temporaryDirectory("marbles-state-");
    const lock = acquireLock(state, "s");
    if (!("release" in lock)) {
      throw new Error("expected the lock");
    }
    writeFileSync(join(state, "locks", "s"), "999999999");
    lock.release();
    expect(readFileSync(join(state, "locks", "s"), "utf8")).toBe("999999999");
  });
});

describe("schedule state", { timeout: 20_000 }, () => {
  const schedule: Schedule = {
    input: "hi",
    key: "s",
    kind: "schedule",
    label: "shout hi",
    trigger: { kind: "interval", ms: 50 },
    workflow: "shout",
  };

  it("keeps each occurrence in the workspace's database for another engine to read", async () => {
    const state = temporaryDirectory("marbles-state-");
    const { print } = collector();
    const engine = await engineIn(state, print);
    engine.schedule(schedule);
    const scheduler = startScheduler(engine);
    const other = defaultWorkspaceTriggers(state, process.cwd(), "test");
    try {
      await vi.waitFor(
        async () =>
          expect(await occurrencesOf({ triggers: other }, "s")).toContainEqual(
            expect.objectContaining({
              state: expect.objectContaining({
                kind: "settled",
                outcome: "complete",
              }),
            })
          ),
        { interval: 50, timeout: 10_000 }
      );
      const stored = await runStoreEffect(
        (await other.schedules()).getSchedule("s")
      );
      expect(stored?.target).toEqual({
        handler: { name: "shout" },
        input: { input: "hi", kind: "schedule", label: "shout hi" },
      });
    } finally {
      await scheduler.stop();
      await other.close();
      await engine.dispose();
    }
  });

  it("fails a roll of a schedule whose run fails", async () => {
    const state = temporaryDirectory("marbles-state-");
    const { print } = collector();
    const engine = await engineIn(state, print);
    try {
      await expect(rollSchedule(engine, schedule, { print })).resolves.toEqual({
        value: "HI",
      });
      await expect(
        rollSchedule(engine, { ...schedule, workflow: "explode" }, { print })
      ).rejects.toThrow(BOOM_PATTERN);
    } finally {
      await engine.dispose();
    }
  });
});
