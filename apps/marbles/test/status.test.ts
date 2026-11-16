import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Sessions } from "@foundry/agents/session";
import { describe, expect, it } from "vitest";
import { initializeDatabase } from "~/database/open";
import { DatabaseSessionStore } from "~/database/sessions";
import { stateDatabase } from "~/layout";
import { writeJson } from "~/lib/state/json";
import { readStatus } from "~/status/model";
import { seedWorkspace } from "./helpers/registry";
import { seedRuns, seedTicks } from "./helpers/stored-runs";
import { temporaryDirectory } from "./helpers/temporary";

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
  const database = await initializeDatabase(stateDatabase(state));
  try {
    const sessions = new Sessions({
      store: new DatabaseSessionStore({
        database: database.database,
        scope: "ws1",
      }),
    });
    await sessions.createSession({ id: "s1" });
    await sessions.createSession({ id: "s2" });
  } finally {
    database.close();
  }
  await seedTicks(state, "ws1", [
    {
      key: "guides",
      last: {
        lastFinish: "2026-09-10T01:00:00.000Z",
        lastStart: "2026-09-10T00:59:00.000Z",
        lastStatus: "complete",
        nextDue: "2026-09-10T01:30:00.000Z",
      },
      owner: null,
    },
  ]);
  writeJson(join(dir, "sessions", "s3.json"), {});
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
    await seedRuns(
      state,
      "ws1",
      Array.from({ length: 7 }, (_, i) => ({
        createdAt: i,
        id: `rn-${String(i)}`,
        owner: null,
        status: "complete" as const,
      }))
    );
    mkdirSync(join(state, "stray"));
    expect(dir).toBe(join(state, "ws1"));

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

  it("reports a tick under way in a live process as running, and ignores a dead one's", async () => {
    const { state } = await layout();
    await seedTicks(state, "ws1", [
      { key: "fresh", owner: process.pid },
      { key: "stale", owner: spawnSync("true").pid },
    ]);
    const schedules = (await readStatus(state)).workspaces[0]?.schedules;
    expect(schedules).toEqual([
      expect.objectContaining({ name: "fresh", running: process.pid }),
      expect.objectContaining({ name: "guides", running: null }),
    ]);
  });

  it("flags an unsettled run whose pid is dead as orphaned", async () => {
    const { state } = await layout();
    const dead = spawnSync("true").pid;
    await seedRuns(state, "ws1", [
      { createdAt: 1, id: "rn-a", owner: dead, status: "running" },
      { createdAt: 2, id: "rn-b", owner: process.pid, status: "running" },
      { createdAt: 3, id: "rn-c", owner: null, status: "failed" },
      { createdAt: 4, id: "rn-d", owner: null, status: "running" },
    ]);

    const recent = (await readStatus(state)).workspaces[0]?.runs.recent;
    expect(recent?.map((r) => [r.id, r.orphaned])).toEqual([
      ["rn-d", true],
      ["rn-c", false],
      ["rn-b", false],
      ["rn-a", true],
    ]);
  });

  it("skips corrupt files and old run files, and dirs the registry does not record", async () => {
    const { state, dir } = await layout();
    await seedRuns(state, "ws1", [
      { createdAt: 1, id: "rn-ok", owner: null, status: "complete" },
    ]);
    writeJson(join(dir, "runs", "rn-old.json"), { pid: 1 });
    writeFileSync(join(dir, "runs", "rn-bad.json"), "{ not json");
    writeJson(join(dir, "schedules", "old.json"), { lastStatus: "failed" });
    writeJson(join(state, "ws2", "workspace.json"), { id: "ws2", root: "/r" });
    mkdirSync(join(state, "ws3"));

    const { workspaces } = await readStatus(state);
    expect(workspaces.map((w) => w.id)).toEqual(["ws1"]);
    expect(workspaces[0]?.runs).toEqual({
      recent: [expect.objectContaining({ id: "rn-ok" })],
      total: 1,
    });
    expect(workspaces[0]?.schedules.map((s) => [s.name, s.lastStatus])).toEqual(
      [["guides", "complete"]]
    );
  });
});
