import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { writeJson } from "~/lib/state/json";
import { readStatus } from "~/status/model";
import { seedWorkspace } from "./helpers/registry";
import { temporaryDirectory } from "./helpers/temporary";

function run(id: string, status: string, createdAt: number, pid: number) {
  return {
    pid,
    run: { id, status, step: "guides", timestamps: { createdAt } },
  };
}

async function layout() {
  const state = temporaryDirectory("marbles-status-");
  const dir = join(state, "ws1");
  await seedWorkspace(state, {
    config: "/repo/one/marbles.config.ts",
    firstSeen: "2026-09-10T00:00:00.000Z",
    hosted: false,
    id: "ws1",
    lastSeen: "2026-09-10T01:00:00.000Z",
    root: "/repo/one",
  });
  writeJson(join(dir, "schedules", "guides.json"), {
    lastFinish: "2026-09-10T01:00:00.000Z",
    lastStart: "2026-09-10T00:59:00.000Z",
    lastStatus: "complete",
    nextDue: "2026-09-10T01:30:00.000Z",
  });
  writeJson(join(dir, "sessions", "s1.json"), {});
  writeJson(join(dir, "sessions", "s2.json"), {});
  return { dir, state };
}

describe("readStatus", () => {
  it("returns no workspaces for a missing or empty root, and creates nothing", async () => {
    const state = temporaryDirectory("marbles-status-");
    expect(await readStatus(join(state, "nope"))).toEqual({
      process: null,
      root: join(state, "nope"),
      workspaces: [],
    });
    expect((await readStatus(state)).workspaces).toEqual([]);
    expect(existsSync(join(state, "nope"))).toBe(false);
    expect(existsSync(join(state, "marbles.db"))).toBe(false);
  });

  it("reads workspace, schedules, runs and sessions", async () => {
    const { state, dir } = await layout();
    for (let i = 0; i < 7; i += 1) {
      writeJson(
        join(dir, "runs", `rn-${String(i)}.json`),
        run(`rn-${String(i)}`, "complete", i, process.pid)
      );
    }
    mkdirSync(join(state, "stray"));

    const [workspace, ...rest] = (await readStatus(state)).workspaces;
    expect(rest).toEqual([]);
    expect(workspace).toMatchObject({
      alive: false,
      config: "/repo/one/marbles.config.ts",
      id: "ws1",
      lastSeen: "2026-09-10T01:00:00.000Z",
      pid: null,
      root: "/repo/one",
      schedules: [
        {
          lastFinish: "2026-09-10T01:00:00.000Z",
          lastStatus: "complete",
          name: "guides",
          nextDue: "2026-09-10T01:30:00.000Z",
          running: null,
        },
      ],
      sessions: 2,
    });
    expect(workspace?.runs.total).toBe(7);
    expect(workspace?.runs.recent.map((r) => r.id)).toEqual([
      "rn-6",
      "rn-5",
      "rn-4",
      "rn-3",
      "rn-2",
    ]);
  });

  it("marks the process alive only while the lock's pid is", async () => {
    const { state, dir } = await layout();
    const dead = spawnSync("true").pid;
    mkdirSync(join(dir, "locks"));
    writeFileSync(join(dir, "locks", "process"), String(dead));
    writeJson(join(dir, "process.json"), {
      host: "worker",
      pid: dead,
      startedAt: "x",
    });
    expect((await readStatus(state)).workspaces[0]).toMatchObject({
      alive: false,
      host: null,
      pid: dead,
    });

    writeFileSync(join(dir, "locks", "process"), String(process.pid));
    writeJson(join(dir, "process.json"), {
      host: "worker",
      pid: process.pid,
      startedAt: "x",
    });
    expect((await readStatus(state)).workspaces[0]).toMatchObject({
      alive: true,
      host: "worker",
      pid: process.pid,
    });
  });

  it("reports a live lock as running and ignores a dead one", async () => {
    const { state, dir } = await layout();
    mkdirSync(join(dir, "locks"));
    writeFileSync(join(dir, "locks", "schedule:guides"), String(process.pid));
    writeFileSync(join(dir, "locks", "schedule:fresh"), String(process.pid));
    writeFileSync(
      join(dir, "locks", "schedule:stale"),
      String(spawnSync("true").pid)
    );

    writeFileSync(join(dir, "locks", "run-probe"), String(process.pid));
    writeFileSync(
      join(dir, "locks", "edit-automation-probe"),
      String(process.pid)
    );
    const schedules = (await readStatus(state)).workspaces[0]?.schedules;
    expect(schedules).toEqual([
      expect.objectContaining({ name: "fresh", running: process.pid }),
      expect.objectContaining({ name: "guides", running: process.pid }),
    ]);
  });

  it("flags an unsettled run whose pid is dead as orphaned", async () => {
    const { state, dir } = await layout();
    const dead = spawnSync("true").pid;
    writeJson(join(dir, "runs", "rn-a.json"), run("rn-a", "running", 1, dead));
    writeJson(
      join(dir, "runs", "rn-b.json"),
      run("rn-b", "running", 2, process.pid)
    );
    writeJson(join(dir, "runs", "rn-c.json"), run("rn-c", "failed", 3, dead));

    const recent = (await readStatus(state)).workspaces[0]?.runs.recent;
    expect(recent?.map((r) => [r.id, r.orphaned])).toEqual([
      ["rn-c", false],
      ["rn-b", false],
      ["rn-a", true],
    ]);
  });

  it("skips corrupt files, and dirs the registry does not record", async () => {
    const { state, dir } = await layout();
    writeJson(join(dir, "runs", "rn-ok.json"), run("rn-ok", "complete", 1, 1));
    writeJson(join(dir, "runs", "rn-hollow.json"), { pid: 1 });
    writeFileSync(join(dir, "runs", "rn-bad.json"), "{ not json");
    writeFileSync(join(dir, "schedules", "bad.json"), "{");
    writeJson(join(state, "ws2", "workspace.json"), { id: "ws2", root: "/r" });
    mkdirSync(join(state, "ws3"));

    const { workspaces } = await readStatus(state);
    expect(workspaces.map((w) => w.id)).toEqual(["ws1"]);
    expect(workspaces[0]?.runs).toEqual({
      recent: [expect.objectContaining({ id: "rn-ok" })],
      total: 1,
    });
    expect(workspaces[0]?.schedules.map((s) => [s.name, s.lastStatus])).toEqual(
      [
        ["bad", null],
        ["guides", "complete"],
      ]
    );
  });
});
