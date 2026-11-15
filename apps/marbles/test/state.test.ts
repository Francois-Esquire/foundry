import { spawnSync } from "node:child_process";
import {
  mkdirSync,
  readdirSync,
  readFileSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { Step } from "@foundry/workflows/step";
import { describe, expect, it } from "vitest";
import { defaultWorkspaceTriggers } from "~/database/managed";
import { readStoredRuns } from "~/database/runs";
import type { ScheduledEngine } from "~/lib/schedule";
import { runSchedules, tick } from "~/lib/schedule";
import { acquireLock } from "~/lib/state/locks";
import type { StateStore } from "~/lib/state/store";
import { InMemoryStateStore, JsonStateStore } from "~/lib/state/store";
import { workspaceState } from "~/lib/state/workspace";
import type { TriggerStore } from "~/lib/trigger-store";
import { MemoryTriggerStore } from "~/lib/trigger-store";
import type { Schedule } from "~/lib/triggers";
import { testEngine } from "./helpers/engine";
import { temporaryDirectory } from "./helpers/temporary";

const SHORT_HEX_ID_PATTERN = /^[0-9a-f]{12}$/;
const BOOM_PATTERN = /boom/;
const PLAIN_NAME = /must be a plain name/;

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

function readJson(path: string): Record<string, unknown> {
  const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
  if (typeof parsed !== "object" || parsed === null) {
    throw new Error(path);
  }
  return { ...parsed };
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
    // Settled: no engine owns any of them.
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
      String(process.pid)
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
    expect(readFileSync(path, "utf8")).toBe(String(process.pid));
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
    // Taken over meanwhile, as by a breaker that judged this process gone.
    writeFileSync(join(state, "locks", "s"), "999999999");
    lock.release();
    expect(readFileSync(join(state, "locks", "s"), "utf8")).toBe("999999999");
  });
});

describe("schedule state", () => {
  const schedule: Schedule = {
    input: "hi",
    key: "s",
    kind: "schedule",
    label: "shout hi",
    trigger: { kind: "interval", ms: 10 },
    workflow: "shout",
  };

  it("records each tick and skips while another engine's tick of it is under way", async () => {
    const state = temporaryDirectory("marbles-state-");
    const { lines, print } = collector();
    const engine = await engineIn(state, print);

    const result = await tick(engine, schedule, { print });
    expect(result).toEqual({ value: "HI" });
    // A later engine over the same state finds the tick, and no claim on it.
    const other = defaultWorkspaceTriggers(state, process.cwd(), "test");
    expect(await other.lastTick("s")).toEqual({
      kind: "schedule",
      label: "shout hi",
      lastFinish: expect.any(String),
      lastStart: expect.any(String),
      lastStatus: "complete",
      nextDue: expect.any(String),
    });

    await expect(
      tick(engine, { ...schedule, workflow: "explode" }, { print })
    ).rejects.toThrow(BOOM_PATTERN);
    expect(await other.lastTick("s")).toMatchObject({ lastStatus: "failed" });

    expect(await other.claimTick("s")).toEqual({ claimed: true });
    await expect(tick(engine, schedule, { print })).resolves.toBe(undefined);
    expect(lines).toContain("[schedule] s skipped: held by this process");
    await other.finishTick("s");
    await other.close();
    await engine.dispose();
  });

  it("gives a tick's claim up when its record cannot be written, so the next tick runs", async () => {
    const memory = new MemoryTriggerStore();
    let refusals = 1;
    const triggers: TriggerStore = {
      claimTick: (key) => memory.claimTick(key),
      clearPendingLaunch: (key) => memory.clearPendingLaunch(key),
      close: () => memory.close(),
      finishTick: (key, history) => {
        if (history !== undefined && refusals > 0) {
          refusals -= 1;
          return Promise.reject(new Error("the database is busy"));
        }
        return memory.finishTick(key, history);
      },
      lastTick: (key) => memory.lastTick(key),
      monitorState: (key) => memory.monitorState(key),
      saveMonitorState: (key, state) => memory.saveMonitorState(key, state),
    };
    let launches = 0;
    const engine = {
      cancel: () => Promise.resolve(),
      has: () => true,
      launch: () => {
        launches += 1;
        return Promise.resolve({ id: "run", result: Promise.resolve("ok") });
      },
      schedules: () => [schedule],
      triggers,
    } as ScheduledEngine;

    await expect(
      tick(engine, schedule, { print: () => undefined })
    ).rejects.toThrow("the database is busy");
    await expect(
      tick(engine, schedule, { print: () => undefined })
    ).resolves.toEqual({ value: "ok" });
    expect(launches).toBe(2);
    expect(await memory.lastTick("s")).toMatchObject({
      lastStatus: "complete",
    });
  });

  it("seeds the loop from the recorded finish so a restart keeps cadence", async () => {
    const triggers = new MemoryTriggerStore();
    await triggers.claimTick("s");
    await triggers.finishTick("s", {
      lastFinish: new Date(95).toISOString(),
      lastStart: new Date(90).toISOString(),
      lastStatus: "complete",
      nextDue: new Date(105).toISOString(),
    });
    const dispatched: number[] = [];
    let clock = 100;
    const controller = new AbortController();
    const engine = {
      cancel: () => Promise.resolve(),
      has: () => true,
      launch: () => {
        dispatched.push(clock);
        controller.abort();
        return Promise.resolve({ id: "run", result: Promise.resolve() });
      },
      schedules: () => [schedule],
      triggers,
    } as ScheduledEngine;

    await runSchedules(engine, {
      now: () => clock,
      print: () => undefined,
      signal: controller.signal,
      sleep: (ms) => {
        clock += ms;
        return Promise.resolve();
      },
    });
    // Without the seed the first tick would wait until 110.
    expect(dispatched).toEqual([105]);
    expect(await triggers.lastTick("s")).toMatchObject({
      lastFinish: new Date(105).toISOString(),
      nextDue: new Date(115).toISOString(),
    });
  });
});

describe.each([
  [
    "JsonStateStore",
    () => new JsonStateStore(temporaryDirectory("marbles-store-")),
    `pid ${String(process.pid)}`,
  ],
  ["InMemoryStateStore", () => new InMemoryStateStore(), "this process"],
] as const)("%s", (_name, open: () => StateStore, holder: string) => {
  it("reads, lists and removes documents by collection and key", () => {
    const store = open();
    expect(store.read("automations", "m")).toBeUndefined();
    expect(store.list("automations")).toEqual([]);
    store.write("automations", "m", { seen: [1] });
    store.write("automations", "a", { seen: [] });
    store.write("usage", "m", { other: true });
    expect(store.read("automations", "m")).toEqual({ seen: [1] });
    expect(
      store.list("automations").map(({ key, value }) => [key, value])
    ).toEqual([
      ["a", { seen: [] }],
      ["m", { seen: [1] }],
    ]);
    expect(store.list("automations")[0]?.modified).toBeGreaterThan(0);
    store.remove("automations", "m");
    store.remove("automations", "never");
    expect(store.read("automations", "m")).toBeUndefined();
    expect(store.read("usage", "m")).toEqual({ other: true });
  });

  it("hands out copies, never its own documents", () => {
    const store = open();
    const written = { files: { "a.md": "1" } };
    store.write("automations", "m", written);
    written.files["a.md"] = "2";
    const read = store.read("automations", "m") as typeof written;
    read.files["a.md"] = "3";
    expect(store.read("automations", "m")).toEqual({ files: { "a.md": "1" } });
  });

  it("moves a collection's revision on every write and removal, and only then", () => {
    const store = open();
    const empty = store.revision("automations");
    expect(store.revision("automations")).toBe(empty);
    store.write("automations", "x", { n: 1 });
    const one = store.revision("automations");
    expect(one).not.toBe(empty);
    store.write("usage", "x", { n: 1 });
    expect(store.revision("automations")).toBe(one);
    store.write("automations", "x", { n: 1 });
    const rewritten = store.revision("automations");
    expect(rewritten).not.toBe(one);
    store.remove("automations", "x");
    expect(store.revision("automations")).not.toBe(rewritten);
  });

  it("holds a lock for one holder until it is released, and says who holds it", () => {
    const store = open();
    const lock = store.lock("s");
    if ("holder" in lock) {
      throw new Error("expected the lock");
    }
    expect(store.lock("s")).toEqual({ holder });
    const other = store.lock("t");
    expect(other).toHaveProperty("release");
    lock.release();
    const again = store.lock("s");
    expect(again).toHaveProperty("release");
    for (const held of [again, other]) {
      if ("release" in held) {
        held.release();
      }
    }
  });

  it("refuses a key or lock name that is not one plain name", () => {
    const store = open();
    for (const name of ["", ".", "..", "a/b", "../escape", "a\\b", "nul\0"]) {
      expect(() => store.write("automations", name, {})).toThrow(PLAIN_NAME);
      expect(() => store.read("automations", name)).toThrow(PLAIN_NAME);
      expect(() => store.remove("automations", name)).toThrow(PLAIN_NAME);
      expect(() => store.lock(name)).toThrow(PLAIN_NAME);
    }
    expect(store.list("automations")).toEqual([]);
    store.write("automations", "automation-1.v2", {});
    expect(store.read("automations", "automation-1.v2")).toEqual({});
  });
});

describe("JsonStateStore", () => {
  it("keeps the layout status reads, and lists an unreadable document with its error", () => {
    const state = temporaryDirectory("marbles-store-");
    const store = new JsonStateStore(state);
    store.write("usage", "s", { lastFinish: "x", version: 1 });
    expect(readJson(join(state, "usage", "s.json"))).toEqual({
      lastFinish: "x",
      version: 1,
    });
    writeFileSync(join(state, "usage", "broken.json"), "{ nope");
    writeFileSync(join(state, "usage", "notes.txt"), "ignored");
    const [broken, kept] = store.list("usage");
    expect(broken?.key).toBe("broken");
    expect(broken?.error).toContain("SyntaxError");
    expect(store.read("usage", "broken")).toBeUndefined();
    expect(kept).toMatchObject({ key: "s", value: { lastFinish: "x" } });
  });
});
