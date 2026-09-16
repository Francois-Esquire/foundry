import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Step } from "@foundry/workflows/step";
import { describe, expect, it } from "vitest";
import { startEngine } from "~/engine";
import type { Schedule } from "~/lib/registry";
import { runSchedules, tick } from "~/schedule";
import { acquireLock } from "~/state/locks";
import { workspaceState } from "~/state/workspace";

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
  return startEngine(
    (orchestrator) => {
      orchestrator.register("shout", new Shout().factory());
      orchestrator.register("quiet", new Quiet().factory());
      orchestrator.register("explode", new Explode().factory());
    },
    { print, state }
  );
}

function readJson(path: string): Record<string, unknown> {
  const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
  if (typeof parsed !== "object" || parsed === null) {
    throw new Error(path);
  }
  return { ...parsed };
}

describe("run files", () => {
  it("writes one file per settled run and lists them across processes", async () => {
    const state = mkdtempSync(join(tmpdir(), "quirks-state-"));
    const { lines, print } = collector();

    const first = await engineIn(state, print);
    await first.run<string>("shout", "one");
    await expect(first.run<never>("explode", undefined)).rejects.toThrow();
    await first.stop();
    expect(readdirSync(join(state, "runs"))).toHaveLength(2);

    const second = await engineIn(state, print);
    await second.run<string>("shout", "two");
    const runs = await second.runs();
    await second.stop();

    expect(runs.map((run) => run.status).sort()).toEqual([
      "complete",
      "complete",
      "failed",
    ]);
    expect(readdirSync(join(state, "runs"))).toHaveLength(3);
    expect(lines.filter((line) => line.startsWith("[state]"))).toEqual([]);
    const file = readJson(join(state, "runs", `${runs[0]?.id ?? ""}.json`));
    expect(file).toMatchObject({ pid: process.pid });
  });

  it("survives a run that returns nothing", async () => {
    const state = mkdtempSync(join(tmpdir(), "quirks-state-"));
    const { lines, print } = collector();
    const engine = await engineIn(state, print);
    await engine.run<undefined>("quiet", undefined);
    await engine.stop();
    expect(lines.filter((line) => line.startsWith("[state]"))).toEqual([]);
    expect(readdirSync(join(state, "runs"))).toHaveLength(1);
  });

  it("skips a corrupt file with a warning instead of failing to start", async () => {
    const state = mkdtempSync(join(tmpdir(), "quirks-state-"));
    mkdirSync(join(state, "runs"));
    writeFileSync(join(state, "runs", "rn-bad.json"), "{ not json");
    writeFileSync(join(state, "runs", "rn-hollow.json"), '{"pid": 1}');
    const { lines, print } = collector();

    const engine = await engineIn(state, print);
    await engine.run<string>("shout", "one");
    const runs = await engine.runs();
    await engine.stop();

    expect(runs).toHaveLength(1);
    expect(lines.filter((line) => line.startsWith("[state] skipped"))).toEqual([
      expect.stringMatching(/^\[state\] skipped runs\/rn-bad\.json: /),
      expect.stringMatching(/^\[state\] skipped runs\/rn-hollow\.json: /),
    ]);
  });
});

describe("workspace", () => {
  it("derives one id per root and upserts workspace.json", () => {
    const state = mkdtempSync(join(tmpdir(), "quirks-state-"));
    const a = mkdtempSync(join(tmpdir(), "quirks-ws-a-"));
    const b = mkdtempSync(join(tmpdir(), "quirks-ws-b-"));

    const first = workspaceState(state, a);
    expect(workspaceState(state, a).id).toBe(first.id);
    expect(workspaceState(state, b).id).not.toBe(first.id);
    expect(first.id).toMatch(/^[0-9a-f]{12}$/);
    expect(first.dir).toBe(join(state, first.id));

    first.touch(join(a, "quirks.config.ts"));
    const seen = readJson(join(first.dir, "workspace.json"));
    expect(seen).toMatchObject({
      config: join(a, "quirks.config.ts"),
      id: first.id,
      root: first.root,
    });
    expect(seen).toHaveProperty("firstSeen");
    expect(seen).toHaveProperty("lastSeen");

    first.touch(null);
    expect(readJson(join(first.dir, "workspace.json"))).toMatchObject({
      config: null,
      firstSeen: seen.firstSeen,
    });
  });
});

describe("locks", () => {
  it("yields to a live holder and replaces a dead one", () => {
    const state = mkdtempSync(join(tmpdir(), "quirks-state-"));
    mkdirSync(join(state, "locks"));

    writeFileSync(join(state, "locks", "s"), String(process.pid));
    expect(acquireLock(state, "s")).toBe(process.pid);

    const dead = spawnSync("true").pid;
    writeFileSync(join(state, "locks", "s"), String(dead));
    const lock = acquireLock(state, "s");
    expect(typeof lock).toBe("object");
    expect(readFileSync(join(state, "locks", "s"), "utf8")).toBe(
      String(process.pid)
    );
    if (typeof lock === "object") {
      lock.release();
    }
    expect(existsSync(join(state, "locks", "s"))).toBe(false);
  });
});

describe("schedule state", () => {
  const schedule: Schedule = {
    input: "hi",
    name: "s",
    trigger: { kind: "interval", ms: 10 },
    workflow: "shout",
  };

  it("records each tick and skips while another process holds the lock", async () => {
    const state = mkdtempSync(join(tmpdir(), "quirks-state-"));
    const { lines, print } = collector();
    const engine = await engineIn(state, print);

    const result = await tick(engine, schedule, { print, state });
    expect(result).toEqual({ value: "HI" });
    expect(existsSync(join(state, "locks", "s"))).toBe(false);
    const history = readJson(join(state, "schedules", "s.json"));
    expect(history.lastStatus).toBe("complete");
    expect(Object.keys(history).sort()).toEqual([
      "lastFinish",
      "lastStart",
      "lastStatus",
      "nextDue",
      "version",
    ]);

    await expect(
      tick(engine, { ...schedule, workflow: "explode" }, { print, state })
    ).rejects.toThrow(/boom/);
    expect(readJson(join(state, "schedules", "s.json"))).toMatchObject({
      lastStatus: "failed",
    });
    expect(existsSync(join(state, "locks", "s"))).toBe(false);

    writeFileSync(join(state, "locks", "s"), String(process.pid));
    await expect(tick(engine, schedule, { print, state })).resolves.toBe(
      undefined
    );
    expect(lines).toContain(
      `[schedule] s skipped: running as pid ${String(process.pid)}`
    );
    await engine.stop();
  });

  it("seeds the loop from the recorded finish so a restart keeps cadence", async () => {
    const state = mkdtempSync(join(tmpdir(), "quirks-state-"));
    mkdirSync(join(state, "schedules"));
    writeFileSync(
      join(state, "schedules", "s.json"),
      JSON.stringify({
        lastFinish: new Date(95).toISOString(),
        lastStart: new Date(90).toISOString(),
        lastStatus: "complete",
        nextDue: new Date(105).toISOString(),
      })
    );
    const dispatched: number[] = [];
    let clock = 100;
    const controller = new AbortController();
    const engine = {
      run: () => {
        dispatched.push(clock);
        controller.abort();
        return Promise.resolve(undefined);
      },
    };

    await runSchedules(engine as never, [schedule], {
      now: () => clock,
      print: () => undefined,
      signal: controller.signal,
      sleep: (ms) => {
        clock += ms;
        return Promise.resolve();
      },
      state,
    });
    // Without the seed the first tick would wait until 110.
    expect(dispatched).toEqual([105]);
    expect(readJson(join(state, "schedules", "s.json"))).toMatchObject({
      lastFinish: new Date(105).toISOString(),
      nextDue: new Date(115).toISOString(),
    });
  });
});
