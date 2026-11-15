import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Sessions } from "@foundry/agents/session";
import { Tasks } from "@foundry/tasks";
import { describe, expect, it } from "vitest";
import { GenerationRecords } from "~/database/generations";
import { initializeDatabase } from "~/database/open";
import { DatabaseRecoveryLog } from "~/database/recoveries";
import { DatabaseSessionStore } from "~/database/sessions";
import { DatabaseWorkspaceRecords } from "~/database/tasks";
import { stateDatabase } from "~/layout";
import { writeJson } from "~/lib/state/json";
import { startedAt } from "~/process/spawned";
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
  // A session file an earlier Marbles left is not one of them.
  writeJson(join(dir, "sessions", "s3.json"), {});
  return { dir, state };
}

describe("readStatus", () => {
  it("returns no workspaces for a missing or empty root, and creates nothing", async () => {
    const state = temporaryDirectory("marbles-status-");
    expect(await readStatus(join(state, "nope"))).toEqual({
      generations: [],
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

  it("reads each observer's place, how far it is behind, and a failing one's error", async () => {
    const { state } = await layout();
    const database = await initializeDatabase(stateDatabase(state));
    try {
      const records = new DatabaseWorkspaceRecords({
        database: database.database,
        scope: "ws1",
      });
      const now = Date.now();
      const steady = { name: "steady", source: "tasks" };
      const flaky = { name: "flaky", source: "tasks" };
      // The fixture's two sessions are facts already: both start after them.
      expect((await records.log.declare(steady, now)).position).toBe(2);
      await records.log.declare(flaky, now);
      const tasks = new Tasks({ store: records.taskStore });
      await tasks.create({ title: "A" });
      await tasks.create({ title: "B" });
      await records.log.move(steady, { from: 2, now, to: 4 });
      await records.log.fail(flaky, {
        error: "down",
        now,
        retryAt: now + 1000,
      });
      await records.close();
    } finally {
      database.close();
    }

    const [workspace] = (await readStatus(state)).workspaces;
    expect(workspace?.observers).toEqual([
      {
        behind: 2,
        failures: 1,
        lastError: "down",
        missed: null,
        name: "flaky",
        position: 2,
        retryAt: expect.any(Number),
        source: "tasks",
      },
      {
        behind: 0,
        failures: 0,
        lastError: null,
        missed: null,
        name: "steady",
        position: 4,
        retryAt: null,
        source: "tasks",
      },
    ]);
  });

  it("marks a registered workspace alive only while the current generation's process is", async () => {
    const { state } = await layout();
    await seedWorkspace(state, {
      config: null,
      firstSeen: "2026-09-10T00:00:00.000Z",
      hosted: true,
      id: "ws2",
      lastSeen: "2026-09-10T01:00:00.000Z",
      root: "/repo/two",
    });
    const hosted = async () =>
      (await readStatus(state)).workspaces.find(
        (workspace) => workspace.id === "ws2"
      );
    const database = await initializeDatabase(stateDatabase(state));
    try {
      const generations = new GenerationRecords({
        database: database.database,
      });
      const dead = await generations.begin("before");
      await generations.spawned(dead, spawnSync("true").pid);
      await generations.mark(dead, "current");
      expect(await hosted()).toMatchObject({
        alive: false,
        host: null,
        pid: null,
      });

      await generations.mark(dead, "exited");
      const live = await generations.begin("after");
      await generations.spawned(live, process.pid);
      await generations.identify(live, startedAt(process.pid) ?? null);
      await generations.mark(live, "current");
      expect(await hosted()).toMatchObject({
        alive: true,
        host: "generation",
        pid: process.pid,
      });
      expect((await readStatus(state)).generations).toEqual([
        { alive: true, number: live, pid: process.pid, state: "current" },
      ]);
      // A workspace not registered is hosted by no generation.
      expect(
        (await readStatus(state)).workspaces.find(
          (workspace) => workspace.id === "ws1"
        )
      ).toMatchObject({ alive: false, host: null });
    } finally {
      database.close();
    }
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
    // Run files an earlier Marbles left are not read.
    writeJson(join(dir, "runs", "rn-old.json"), { pid: 1 });
    writeFileSync(join(dir, "runs", "rn-bad.json"), "{ not json");
    // Nor are schedule files.
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

describe("the last recovery in readStatus", () => {
  it("is each workspace's last start's report, and none before one ran", async () => {
    const { state } = await layout();
    expect((await readStatus(state)).workspaces[0]?.recovery).toBeNull();
    const report = {
      at: "2026-09-10T02:00:00.000Z",
      steps: [
        { detail: "Error: busy", outcome: "failed", step: "runs" },
      ] as const,
    };
    const database = await initializeDatabase(stateDatabase(state));
    try {
      await new DatabaseRecoveryLog({
        database: database.database,
        scope: "ws1",
      }).record(report);
    } finally {
      database.close();
    }
    expect((await readStatus(state)).workspaces[0]?.recovery).toEqual(report);
  });
});
