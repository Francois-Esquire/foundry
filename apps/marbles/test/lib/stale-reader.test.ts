/**
 * An engine that read a run before another process took it over never
 * cancels or prunes it from what it read: both decide on the stored
 * record, so the run another process is running keeps its record.
 */

import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { afterEach, expect, it } from "vitest";
import { DatabaseExecutionStore } from "~/database/executions";
import type { MarblesDatabase } from "~/database/open";
import { initializeDatabase } from "~/database/open";
import { stateDatabase } from "~/layout";
import { parseStored } from "~/lib/execution-record";
import { Executions } from "~/lib/executions";
import { exitedPid } from "../helpers/executions";

const SOURCE = resolve(import.meta.dirname, "../../src");
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

/**
 * Another engine, in a process of its own: it takes over the exited
 * process's queued run, starts it, says `running`, and holds it running
 * until its stdin ends, then says what it and the database hold of it.
 */
function adopter(file: string) {
  const script = `
    const { openDatabase } = await import(${JSON.stringify(join(SOURCE, "database/open.ts"))});
    const { DatabaseExecutionStore } = await import(${JSON.stringify(join(SOURCE, "database/executions.ts"))});
    const { Executions } = await import(${JSON.stringify(join(SOURCE, "lib/executions.ts"))});
    const opened = await openDatabase(${JSON.stringify(file)});
    const store = new DatabaseExecutionStore({ database: opened.database, scope: "ws" });
    const records = new Executions({ store, warn: (line) => console.error(line) });
    await records.load();
    await records.recover({ adopted: new Set(), readmit: () => true });
    const held = Promise.withResolvers();
    records.admit("rn-shared", () => held.promise, (error) => console.error(error));
    await records.flush();
    console.log("running");
    for await (const _ of Bun.stdin.stream()) break;
    const stored = await store.get("rn-shared");
    console.log(JSON.stringify({ local: records.get("rn-shared")?.status, stored: stored?.value?.status ?? null }));
    held.resolve();
    opened.close();
  `;
  const child = spawn("bun", ["-e", script], {
    cwd: resolve(import.meta.dirname, "../.."),
    stdio: ["pipe", "pipe", "inherit"],
  });
  const lines = createInterface({ input: child.stdout })[
    Symbol.asyncIterator
  ]();
  const next = async () => String((await lines.next()).value);
  const exited = new Promise<number | null>((done) =>
    child.on("exit", (code) => done(code))
  );
  return { child, exited, next };
}

it("neither cancels nor prunes a run another process took over and is running, from what it read before", {
  timeout: 30_000,
}, async () => {
  const root = mkdtempSync(join(tmpdir(), "marbles-stale-reader-"));
  roots.push(root);
  const file = stateDatabase(root);
  const opened = await initializeDatabase(file);
  handles.push(opened);
  const store = new DatabaseExecutionStore({
    database: opened.database,
    scope: "ws",
  });
  const at = new Date().toISOString();
  await store.create({
    correlation: {},
    id: "rn-shared",
    kind: "task",
    name: "work",
    observations: [],
    owner: { pid: exitedPid(), started: null },
    queue: "q",
    revision: 1,
    sequence: 1,
    status: "queued",
    timestamps: { queuedAt: at, updatedAt: at },
  });
  const removed: string[] = [];
  const stale = new Executions({
    removed: (run) => {
      removed.push(run.id);
    },
    store,
    warn: () => undefined,
  });
  // Read while the run was queued under the exited process.
  await stale.load();
  expect(stale.get("rn-shared")?.status).toBe("queued");

  const other = adopter(file);
  expect(await other.next()).toBe("running");

  expect(await stale.withdraw("rn-shared")).toBe(false);
  // It holds what the store holds now, not a cancellation it never stored.
  expect(stale.get("rn-shared")?.status).toBe("running");
  expect(await stale.prune(["rn-shared"], () => "host")).toEqual([]);
  expect(removed).toEqual([]);
  const kept = await store.get("rn-shared");
  expect(kept && parseStored(kept)?.status).toBe("running");

  other.child.stdin.end();
  expect(JSON.parse(await other.next())).toEqual({
    local: "running",
    stored: "running",
  });
  expect(await other.exited).toBe(0);
});

/**
 * Another engine, in a process of its own, that reports progress on the
 * run `rn-owned` until its stdin ends, then says how many it reported and
 * how many the store dropped.
 */
function reporter(file: string) {
  const script = `
    const { openDatabase } = await import(${JSON.stringify(join(SOURCE, "database/open.ts"))});
    const { DatabaseExecutionStore } = await import(${JSON.stringify(join(SOURCE, "database/executions.ts"))});
    const opened = await openDatabase(${JSON.stringify(file)});
    const store = new DatabaseExecutionStore({ database: opened.database, scope: "ws" });
    let ended = false;
    (async () => { for await (const _ of Bun.stdin.stream()) {} ended = true; })();
    let made = 0;
    let dropped = 0;
    console.log("reporting");
    while (!ended) {
      const written = await store.advise("rn-owned", { progress: { n: made + dropped }, updatedAt: new Date().toISOString() });
      if (written.applied) made += 1; else dropped += 1;
      await Bun.sleep(1);
    }
    console.log(JSON.stringify({ dropped, made }));
    opened.close();
  `;
  const child = spawn("bun", ["-e", script], {
    cwd: resolve(import.meta.dirname, "../.."),
    stdio: ["pipe", "pipe", "inherit"],
  });
  const lines = createInterface({ input: child.stdout })[
    Symbol.asyncIterator
  ]();
  const next = async () => String((await lines.next()).value);
  const exited = new Promise<number | null>((done) =>
    child.on("exit", (code) => done(code))
  );
  return { child, exited, next };
}

it("settles a run its owner finished while another process keeps reporting progress on it, and drops what that process reports after", {
  timeout: 30_000,
}, async () => {
  const root = mkdtempSync(join(tmpdir(), "marbles-progress-race-"));
  roots.push(root);
  const file = stateDatabase(root);
  const opened = await initializeDatabase(file);
  handles.push(opened);
  const store = new DatabaseExecutionStore({
    database: opened.database,
    scope: "ws",
  });
  const owner = new Executions({ store, warn: () => undefined });
  const { run } = await owner.enqueue({
    kind: "task",
    name: "work",
    queue: "q",
  });
  // Recorded under a fixed id the other process names.
  const at = new Date().toISOString();
  await store.create({
    ...run,
    id: "rn-owned",
    timestamps: { queuedAt: at, updatedAt: at },
  });
  await owner.load();
  const held = Promise.withResolvers<void>();
  const started = Promise.withResolvers<void>();
  owner.admit(
    "rn-owned",
    async () => {
      started.resolve();
      await held.promise;
    },
    () => undefined
  );
  await started.promise;

  const other = reporter(file);
  expect(await other.next()).toBe("reporting");
  await new Promise((wake) => setTimeout(wake, 50));
  held.resolve();
  const settled = await owner.settle("rn-owned", "complete");
  expect(settled?.status).toBe("complete");
  await new Promise((wake) => setTimeout(wake, 50));
  other.child.stdin.end();
  const counts = JSON.parse(await other.next()) as {
    dropped: number;
    made: number;
  };
  expect(await other.exited).toBe(0);

  expect(counts.made).toBeGreaterThan(0);
  expect(counts.dropped).toBeGreaterThan(0);
  const kept = await store.get("rn-owned");
  expect(kept && parseStored(kept)?.status).toBe("complete");
});
