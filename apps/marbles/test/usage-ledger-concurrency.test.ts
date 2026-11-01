import { type ChildProcess, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import type { StateCollection } from "~/lib/state/store";
import { JsonStateStore } from "~/lib/state/store";
import type { RecordedUsageFact, RecordOutcome } from "~/lib/usage";
import { UsageLedger } from "~/lib/usage";

/*
 * Engines in separate processes may share one state dir and continue one
 * session, so the direct session's usage document is written by more than
 * one of them.
 */

let state: string;

beforeEach(async () => {
  state = await mkdtemp(join(tmpdir(), "marbles-usage-concurrency-"));
});

afterEach(async () => {
  await rm(state, { force: true, recursive: true });
});

function directFact(turnId: string): RecordedUsageFact {
  return {
    agentId: "helper",
    completedAt: 1,
    cost: {
      amount: 0.5,
      currency: "USD",
      kind: "reported",
      reference: "probe",
    },
    scope: "direct",
    sessionId: "shared",
    tokens: { input: 2, output: 3, total: 5 },
    turnId,
    version: 1,
    workspaceId: "ws",
  };
}

/** A JSON store that runs `during` once, between its next usage read and the write that follows it. */
class InterleavingStore extends JsonStateStore {
  during: (() => void) | undefined;

  override read(collection: StateCollection, key: string): unknown {
    const value = super.read(collection, key);
    const { during } = this;
    this.during = undefined;
    during?.();
    return value;
  }
}

it("a writer that records while another merges the same direct document keeps both facts, priced and owned", () => {
  const first = new InterleavingStore(state);
  const other = new UsageLedger(new JsonStateStore(state));
  const outcomes: RecordOutcome[] = [];
  first.during = () => outcomes.push(other.record(directFact("other")));
  outcomes.push(new UsageLedger(first).record(directFact("first")));
  expect(outcomes).toEqual([{ saved: "fact" }, { saved: "fact" }]);
  const records = new UsageLedger(new JsonStateStore(state)).read();
  expect(records).toMatchObject({ unreadable: 0, unsaved: 0 });
  expect(records.facts.map((fact) => fact.turnId).sort()).toEqual([
    "first",
    "other",
  ]);
  expect(records.facts.every((fact) => fact.cost.kind === "reported")).toBe(
    true
  );
});

it("a fact whose document another process has locked, or whose lock cannot be taken, is saved whole beside it", async () => {
  const holder = spawn("sleep", ["30"], { stdio: "ignore" });
  try {
    await mkdir(join(state, "locks"), { recursive: true });
    await writeFile(
      join(state, "locks", "usage-direct.shared"),
      String(holder.pid)
    );
    const ledger = new UsageLedger(new JsonStateStore(state));
    expect(ledger.record(directFact("while-held"))).toEqual({ saved: "fact" });
    expect(existsSync(join(state, "usage", "direct.shared.json"))).toBe(false);
    expect(
      existsSync(join(state, "usage", "direct.shared+while-held.json"))
    ).toBe(true);
  } finally {
    holder.kill();
  }

  class Unlockable extends JsonStateStore {
    override lock(): never {
      throw new Error("EACCES: permission denied, mkdir 'locks'");
    }
  }
  const unlockable = new UsageLedger(new Unlockable(state));
  expect(unlockable.record(directFact("no-lock"))).toEqual({ saved: "fact" });
  const records = new UsageLedger(new JsonStateStore(state)).read();
  expect(records.facts.map((fact) => fact.turnId).sort()).toEqual([
    "no-lock",
    "while-held",
  ]);
});

const WRITERS = 4;
const TURNS = 50;
const SOURCE = resolve(import.meta.dirname, "../src");
/** How long a writer, or the test, waits for the others before giving up. */
const READY_MS = 20_000;

/** One process recording `TURNS` direct facts once every writer is ready; it gives up if the barrier never opens. */
function writer(id: number, barrier: string) {
  const script = `
    const { existsSync, writeFileSync } = await import("node:fs");
    const { UsageLedger } = await import(${JSON.stringify(join(SOURCE, "lib/usage.ts"))});
    const { JsonStateStore } = await import(${JSON.stringify(join(SOURCE, "lib/state/store.ts"))});
    const barrier = ${JSON.stringify(barrier)};
    writeFileSync(barrier + ".ready-${id}", "");
    const until = Date.now() + ${READY_MS};
    while (!existsSync(barrier)) {
      if (Date.now() > until) process.exit(2);
      await Bun.sleep(1);
    }
    const ledger = new UsageLedger(new JsonStateStore(${JSON.stringify(state)}));
    const fact = ${JSON.stringify(directFact("template"))};
    const saved = [];
    for (let turn = 0; turn < ${TURNS}; turn += 1) {
      saved.push(ledger.record({ ...fact, turnId: "w${id}-" + turn }).saved);
    }
    console.log(JSON.stringify(saved));
  `;
  const child = spawn("bun", ["-e", script], {
    stdio: ["ignore", "pipe", "inherit"],
  });
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
  // Readiness may still be pending when a child exits; retain the rejection for callers.
  done.catch(() => undefined);
  return { child, done };
}

/** Every writer's outcomes, once all are ready by `deadline`; none outlives it, whatever happens. */
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
  const records = new UsageLedger(new JsonStateStore(state)).read();
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
