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
  await store.put({
    correlation: {},
    id: "rn-shared",
    kind: "task",
    name: "work",
    observations: [],
    owner: { pid: exitedPid() },
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
