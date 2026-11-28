import { type ChildProcess, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import type { MarblesDatabase } from "~/database/open";
import { initializeDatabase } from "~/database/open";
import { DatabaseUsageStore } from "~/database/usage";
import { stateDatabase } from "~/layout";
import { UsageLedger } from "~/lib/usage";
import { recordSpawned } from "~/process/spawned";
import { directFact } from "./helpers/usage-store";

let state: string;
let database: MarblesDatabase;

beforeEach(async () => {
  state = await mkdtemp(join(tmpdir(), "marbles-usage-concurrency-"));
  database = await initializeDatabase(stateDatabase(state));
});

afterEach(async () => {
  database.close();
  await rm(state, { force: true, recursive: true });
});

function ledger(): UsageLedger {
  return new UsageLedger(
    new DatabaseUsageStore({ database: database.database, scope: "ws" })
  );
}

it("two engines recording into one direct session at once keep both facts, priced and owned", async () => {
  const outcomes = await Promise.all([
    ledger().record(directFact("first")),
    ledger().record(directFact("other")),
  ]);
  expect(outcomes).toEqual([{ saved: "fact" }, { saved: "fact" }]);
  const records = await ledger().read();
  expect(records).toMatchObject({ unreadable: 0, unsaved: 0 });
  expect(records.facts.map((fact) => fact.turnId).sort()).toEqual([
    "first",
    "other",
  ]);
  expect(records.facts.every((fact) => fact.cost.kind === "reported")).toBe(
    true
  );
});

const WRITERS = 4;
const TURNS = 50;
const SOURCE = resolve(import.meta.dirname, "../src");
const READY_MS = 20_000;

function writer(id: number, barrier: string) {
  const script = `
    const { existsSync, writeFileSync } = await import("node:fs");
    const { UsageLedger } = await import(${JSON.stringify(join(SOURCE, "lib/usage/index.ts"))});
    const { DatabaseUsageStore } = await import(${JSON.stringify(join(SOURCE, "database/usage.ts"))});
    const { openDatabase } = await import(${JSON.stringify(join(SOURCE, "database/open.ts"))});
    const barrier = ${JSON.stringify(barrier)};
    writeFileSync(barrier + ".ready-${id}", "");
    const until = Date.now() + ${READY_MS};
    while (!existsSync(barrier)) {
      if (Date.now() > until) process.exit(2);
      await Bun.sleep(1);
    }
    const opened = await openDatabase(${JSON.stringify(stateDatabase(state))});
    const ledger = new UsageLedger(
      new DatabaseUsageStore({ database: opened.database, scope: "ws" })
    );
    const fact = ${JSON.stringify(directFact("template"))};
    const saved = [];
    for (let turn = 0; turn < ${TURNS}; turn += 1) {
      saved.push((await ledger.record({ ...fact, turnId: "w${id}-" + turn })).saved);
    }
    opened.close();
    console.log(JSON.stringify(saved));
  `;
  const child = spawn("bun", ["-e", script], {
    stdio: ["ignore", "pipe", "inherit"],
  });
  recordSpawned(child.pid, false);
  let out = "";
  child.stdout.on("data", (chunk: Buffer) => {
    out += chunk.toString();
  });
  const done = new Promise<string[]>((succeed, fail) => {
    child.on("error", fail);
    child.on("exit", (code) =>
      code === 0
        ? succeed(JSON.parse(out) as string[])
        : fail(new Error(`writer ${String(id)} exited ${String(code)}`))
    );
  });
  done.catch(() => undefined);
  return { child, done };
}

async function recordTogether(
  barrier: string,
  deadline: number,
  spawned: ChildProcess[] = []
): Promise<string[]> {
  const writers = Array.from({ length: WRITERS }, (_, id) =>
    writer(id, barrier)
  );
  spawned.push(...writers.map(({ child }) => child));
  try {
    while (!writers.every((_, id) => existsSync(`${barrier}.ready-${id}`))) {
      if (Date.now() > deadline) {
        throw new Error("the writers never got ready");
      }
      await new Promise((wake) => setTimeout(wake, 5));
    }
    await writeFile(barrier, "");
    return (await Promise.all(writers.map(({ done }) => done))).flat();
  } finally {
    for (const { child } of writers) {
      child.kill();
    }
    await Promise.allSettled(writers.map(({ done }) => done));
  }
}

it("independent processes recording into one direct session lose no fact they report saved", {
  timeout: 30_000,
}, async () => {
  const outcomes = await recordTogether(
    join(state, "go"),
    Date.now() + READY_MS
  );
  expect(outcomes).toEqual(new Array(WRITERS * TURNS).fill("fact"));
  const records = await ledger().read();
  expect(records).toMatchObject({ unreadable: 0, unsaved: 0 });
  expect(new Set(records.facts.map((fact) => fact.turnId)).size).toBe(
    WRITERS * TURNS
  );
});

it("a writer failing during readiness is observed and all writers are stopped", async () => {
  const spawned: ChildProcess[] = [];
  const running = recordTogether(join(state, "go"), Date.now() + 500, spawned);
  const rejected = expect(running).rejects.toThrow(
    "the writers never got ready"
  );
  spawned[0]?.kill();
  await rejected;
  expect(spawned).toHaveLength(WRITERS);
  expect(
    spawned.every(
      (child) => child.exitCode !== null || child.signalCode !== null
    )
  ).toBe(true);
});
