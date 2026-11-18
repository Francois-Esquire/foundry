import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SessionMessage } from "@foundry/agents/session";
import { Sessions } from "@foundry/agents/session";
import type { SessionStore, SessionStoreWrite } from "@foundry/agents/store";
import { InMemorySessionStore } from "@foundry/agents/store/memory";
import { ArtifactManager } from "@foundry/artifacts";
import { blobFiles, JsonArtifactStore } from "@foundry/artifacts/node";
import type { SQL } from "drizzle-orm";
import { sql } from "drizzle-orm";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { step } from "~/authoring/builder";
import { catalog } from "~/authoring/catalog";
import { agent } from "~/authoring/resources";
import type { MarblesDatabase } from "~/database/open";
import { initializeDatabase, openDatabase } from "~/database/open";
import { DatabaseSessionStore } from "~/database/sessions";
import { DatabaseUsageStore } from "~/database/usage";
import { stateDatabase } from "~/layout";
import type { Engine } from "~/lib/engine";
import type { SessionRef } from "~/lib/types";
import type { PriceLookup, TurnSource, UsageFact } from "~/lib/usage";
import { RECOVERED, UsageLedger, usageFact } from "~/lib/usage";
import type {
  ListedSessionStore,
  ReconciledRun,
  SessionStamp,
} from "~/lib/usage-evidence";
import {
  ledgerNames,
  transcriptTurn,
  UNATTRIBUTED,
  UsageEvidence,
} from "~/lib/usage-evidence";
import type { UsageStore } from "~/lib/usage-store";
import { MemoryUsageStore } from "~/lib/usage-store";
import { costLabel, tokensLabel } from "~/views/usage-format";
import { registerSetupStep, SETUP_STEP } from "~/workspace/setup-step";
import { dashboardSnapshot } from "~/workspace/snapshot";
import { DEFAULT_DRAFT } from "~/workspace/templates";
import { totalOf, workspaceUsage } from "~/workspace/usage";
import { durableSessions, transcriptOf } from "./helpers/durable-sessions";
import { startEngine, testEngine } from "./helpers/engine";
import { testMachine } from "./helpers/records";
import { temporaryDirectory } from "./helpers/temporary";
import {
  FailingUsageStore,
  putStoredFact,
  storedUsage,
} from "./helpers/usage-store";

const engines: Engine[] = [];
const handles: MarblesDatabase[] = [];
let state: string;

beforeEach(async () => {
  state = await mkdtemp(join(tmpdir(), "marbles-usage-"));
});

afterEach(async () => {
  await Promise.all(engines.splice(0).map((engine) => engine.dispose()));
  for (const handle of handles.splice(0)) {
    handle.close();
  }
  catalog.reset();
  await rm(state, { force: true, recursive: true });
});

async function databaseUsage(): Promise<UsageStore> {
  const opened = await initializeDatabase(stateDatabase(state));
  handles.push(opened);
  return new DatabaseUsageStore({ database: opened.database, scope: "test" });
}

async function failingUsage(
  fail: (write: number) => boolean
): Promise<UsageStore> {
  return new FailingUsageStore(await databaseUsage(), fail);
}

async function reread() {
  const records = await storedUsage(state);
  if (records === undefined) {
    throw new Error(`no Marbles database at ${state}`);
  }
  return records;
}

async function reportStored(runId: string): Promise<void> {
  for (const fact of (await reread()).facts) {
    if (fact.scope === "run" && fact.runId === runId) {
      await putStoredFact(state, {
        runId,
        turnId: fact.turnId,
        value: {
          ...fact,
          cost: {
            amount: 2,
            currency: "USD",
            kind: "reported",
            reference: "probe",
          },
        },
      });
    }
  }
}

async function started(options: Parameters<typeof startEngine>[0] = {}) {
  const engine = await startEngine({ print: () => undefined, ...options });
  engines.push(engine);
  return engine;
}

it("records one fact per turn, attributed to the run, its root definition, and the step it ran in", async () => {
  const reviewer = agent({ name: "reviewer", prompt: "Review." });
  const nested = step("nested").do(async ({ agents }) => {
    const session = await agents.session(reviewer);
    return (await session.generate("nested turn")).text;
  });
  step("outer").do(async ({ agents }) => {
    const session = await agents.session(reviewer);
    await session.generate("first");
    await session.generate("second");
    return await nested.run();
  });
  const engine = await started();
  const launched = await engine.launch("outer", {});
  await launched.result;

  const { facts, unreadable } = await engine.usage.read();
  expect(unreadable).toBe(0);
  expect(facts).toHaveLength(3);
  expect(new Set(facts.map((fact) => fact.turnId)).size).toBe(3);
  for (const fact of facts) {
    expect(fact).toMatchObject({
      agentId: "reviewer",
      definitionId: "outer",
      runId: launched.id,
      workspaceId: "test",
    });
    expect(fact.tokens?.total).toBeGreaterThan(0);
    expect(fact.cost).toEqual({
      kind: "unknown",
      reason: `no list price for ${fact.provider}/${fact.model}`,
    });
  }
  const paths = facts.map((fact) =>
    fact.scope === "run" ? fact.path.join(".") : "direct"
  );
  expect(paths.filter((path) => path === "outer")).toHaveLength(2);
  const child = paths.find((path) => path !== "outer");
  expect(child?.startsWith("outer.")).toBe(true);
});

it("attributes a host task's agent usage to its execution run", async () => {
  const reviewer = agent({ name: "task-reviewer", prompt: "Review." });
  const engine = await started();
  engine.task({
    name: "host-review",
    run: async (_input, { agents }) => {
      const session = await agents.session(reviewer);
      return (await session.generate("review")).text;
    },
  });
  const launched = await engine.launch("host-review", {});
  await launched.result;
  expect((await engine.readUsage()).facts).toMatchObject([
    {
      agentId: "task-reviewer",
      definitionId: "host-review",
      path: ["host-review"],
      runId: launched.id,
      scope: "run",
      workspaceId: "test",
    },
  ]);
});

it("a replayed one-turn call records nothing new; a turn run again records once more", async () => {
  const reviewer = agent({ name: "replayer", prompt: "Review." });
  let gate = new Promise<void>(() => undefined);
  let release: () => void = () => undefined;
  let attempts = 0;
  step("review").do(async ({ agents, signal }) => {
    attempts += 1;
    await reviewer.generate("one-turn call");
    const session = await agents.session(reviewer);
    await session.generate("session turn");
    await Promise.race([
      gate,
      new Promise((_, reject) => {
        signal.addEventListener("abort", () => reject(signal.reason), {
          once: true,
        });
      }),
    ]);
    return "done";
  });
  const engine = await started();
  const launched = await engine.launch<string>("review", {});
  await vi.waitFor(async () =>
    expect((await engine.usage.read()).facts).toHaveLength(2)
  );
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(engine.pause(launched.id, "review")).toBe(true);
  await vi.waitFor(async () =>
    expect((await engine.runs())[0]?.status).toBe("suspended")
  );
  gate = new Promise((resolve) => {
    release = resolve;
  });
  release();
  await engine.resume(launched.id, "review");
  await expect(launched.result).resolves.toBe("done");
  expect(attempts).toBe(2);
  const turns = (await engine.usage.read()).facts;
  expect(turns).toHaveLength(3);
  expect(new Set(turns.map((fact) => fact.sessionId)).size).toBe(2);
});

it("turns outside a run are recorded as direct: their agent and session, no run or workflow", async () => {
  const engine = await started();
  const helper = agent({ name: "helper", prompt: "Help." });
  const session = await engine.agents.session(helper);
  await session.generate("direct generate");
  const streamed = session.stream("direct stream");
  for await (const _event of streamed) {
    // Drain the stream; its finish commits the turn.
  }
  await streamed.message;
  await engine.agents.turns().generate(helper, "one-turn call");

  const { facts } = await engine.usage.read();
  expect(facts).toHaveLength(3);
  for (const fact of facts) {
    expect(fact).toMatchObject({
      agentId: "helper",
      scope: "direct",
      workspaceId: "test",
    });
    expect(fact).not.toHaveProperty("runId");
    expect(fact).not.toHaveProperty("definitionId");
    expect(fact.tokens?.total).toBeGreaterThan(0);
  }
  expect(
    facts.filter((fact) => fact.sessionId === session.ref.id)
  ).toHaveLength(2);
  const { byRun, usage } = workspaceUsage(await engine.usage.read(), "test");
  expect(byRun.size).toBe(0);
  expect(usage.byWorkflow).toEqual([]);
  expect(usage.byAgent.map((group) => [group.id, group.total.turns])).toEqual([
    ["helper", 3],
  ]);
  expect(usage.outsideRuns.turns).toBe(3);
  expect(usage.total.turns).toBe(3);
});

function message(id: string, overrides: Partial<SessionMessage> = {}) {
  return {
    createdAt: 1,
    id,
    metadata: {
      model: { harness: "claude-code", id: "sonnet", provider: "anthropic" },
      timing: { completedAt: 2000, durationMs: 1500, startedAt: 500 },
      usage: {
        cachedInputTokens: 400_000,
        inputTokens: 1_000_000,
        outputTokens: 100_000,
        reasoningTokens: 50_000,
        totalTokens: 1_100_000,
      },
    },
    parts: [],
    role: "assistant",
    sessionId: "session-1",
    status: "complete",
    updatedAt: 2,
    ...overrides,
  } as SessionMessage;
}

const source: TurnSource = {
  agentId: "reviewer",
  run: { definition: "outer", path: ["outer", "child"], runId: "run-1" },
};

it("estimates at the catalog's list price and keeps the rates it used", () => {
  const rates = { cachedInput: 0.3, input: 3, output: 15 };
  const price: PriceLookup = (provider, model) =>
    provider === "anthropic" && model === "sonnet"
      ? { rates: { ...rates }, reference: "@foundry/models anthropic/sonnet" }
      : undefined;
  const fact = usageFact(
    { message: message("m1"), route: {}, source, workspaceId: "ws" },
    price
  );
  expect(fact.cost).toEqual({
    amount: 1.8 + 0.12 + 1.5,
    currency: "USD",
    kind: "estimated",
    pricing: { rates, reference: "@foundry/models anthropic/sonnet" },
  });
  expect(fact).not.toHaveProperty("harness");
  expect(fact).toMatchObject({
    completedAt: 2000,
    durationMs: 1500,
    path: ["outer", "child"],
    tokens: { cachedInput: 400_000, input: 1_000_000, output: 100_000 },
    turnId: "m1",
  });
});

it("a turn that reported no tokens is unknown, never zero", () => {
  const fact = usageFact(
    {
      message: message("m2", {
        metadata: {
          model: { id: "sonnet", provider: "anthropic" },
          usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
        },
      }),
      route: {},
      source,
      workspaceId: "ws",
    },
    () => ({ rates: { input: 3, output: 15 }, reference: "r" })
  );
  expect(fact.tokens).toBeUndefined();
  expect(fact.cost).toEqual({
    kind: "unknown",
    reason: "the harness reported no token usage",
  });
});

it("stored facts survive a restart, record each turn once, and count what cannot be read", async () => {
  const fact: UsageFact = usageFact(
    { message: message("m3"), route: {}, source, workspaceId: "ws" },
    () => undefined
  );
  const first = new UsageLedger(await databaseUsage());
  await first.record(fact);
  await first.record(fact);
  await first.record({ ...fact, turnId: "m4" });

  expect((await reread()).facts.map((item) => item.turnId).sort()).toEqual([
    "m3",
    "m4",
  ]);

  await putStoredFact(state, {
    runId: "run-1",
    turnId: "x",
    value: "{not json",
  });
  const after = await reread();
  expect(after.facts).toHaveLength(2);
  expect(after.unreadable).toBe(1);
});

const priced: PriceLookup = () => ({
  rates: { input: 3, output: 15 },
  reference: "@foundry/models anthropic/sonnet",
});

it("after a restart, syntactically valid but malformed facts count as unreadable and never break totals", async () => {
  const good = usageFact(
    { message: message("good"), route: {}, source, workspaceId: "ws" },
    priced
  );
  await new UsageLedger(await databaseUsage()).record(good);
  const base = JSON.parse(JSON.stringify(good)) as Record<string, unknown>;
  const cost = base.cost as Record<string, unknown>;
  const malformed: Record<string, Record<string, unknown>> = {
    amount: { ...base, cost: { ...cost, amount: "bad" } },
    currency: { ...base, cost: { ...cost, currency: 7 } },
    kind: { ...base, cost: { ...cost, kind: "free" } },
    negative: { ...base, cost: { ...cost, amount: -1 } },
    noScope: { ...base, scope: undefined },
    path: { ...base, path: ["outer", 3] },
    pricing: { ...base, cost: { ...cost, pricing: { reference: "r" } } },
    reason: { ...base, cost: { kind: "unknown" } },
    session: { ...base, sessionId: "" },
    time: { ...base, completedAt: "yesterday" },
    tokens: { ...base, tokens: { input: 1, output: 1, total: "2" } },
  };
  for (const [name, value] of Object.entries(malformed)) {
    await putStoredFact(state, {
      runId: "run-1",
      turnId: `bad-${name}`,
      value: { ...value, turnId: `bad-${name}` },
    });
  }
  const reopened = await reread();
  expect(reopened.facts.map((fact) => fact.turnId)).toEqual(["good"]);
  expect(reopened.unreadable).toBe(Object.keys(malformed).length);
  const total = totalOf(reopened.facts);
  expect(() => costLabel(total)).not.toThrow();
  expect(costLabel(total)).toBe("$4.50 est.");
  expect(tokensLabel(total)).toContain("1 turn");
});

it("a run read while it settles, before its file is written, is never counted as unreadable", async () => {
  const built = testEngine({
    artifacts: new ArtifactManager({
      files: blobFiles(join(state, "artifacts", "blobs")),
      store: new JsonArtifactStore({
        path: join(state, "artifacts", "records.json"),
      }),
    }),
    print: () => undefined,
    sessions: durableSessions(state),
    state,
  });
  registerSetupStep(built);
  const engine = await built.start();
  engines.push(engine);
  let settled = false;
  const finished = engine
    .run(SETUP_STEP, {
      configPath: join(state, ".foundry", "marbles"),
      draft: DEFAULT_DRAFT,
      root: state,
    })
    .finally(() => {
      settled = true;
    });
  const reads: Awaited<ReturnType<Engine["readUsage"]>>[] = [];
  while (!settled) {
    reads.push(await engine.readUsage());
    await new Promise((resolve) => setImmediate(resolve));
  }
  await finished;
  reads.push(await engine.readUsage());
  expect(reads.length).toBeGreaterThan(1);
  for (const records of reads) {
    expect(records.unreadableAt).toEqual({
      direct: 0,
      runs: new Map(),
      unowned: 0,
    });
  }
});

it("a second turn whose usage cannot be saved leaves a marker, so the first turn's total says it is partial, after a restart too", async () => {
  const usageStore = await failingUsage((write) => write === 2);
  const warnings: string[] = [];
  const reviewer = agent({ name: "reviewer", prompt: "Review." });
  step("two").do(async ({ agents }) => {
    const session = await agents.session(reviewer);
    await session.generate("first");
    await session.generate("second");
    return "done";
  });
  const engine = await started({
    print: (line) => warnings.push(line),
    usageStore,
  });
  const launched = await engine.launch<string>("two", {});
  await expect(launched.result).resolves.toBe("done");
  const { facts, unsaved } = await engine.usage.read();
  expect(unsaved).toBe(0);
  expect(facts).toHaveLength(2);
  const lost = facts.find((fact) => fact.lost !== undefined);
  expect(lost).toMatchObject({
    agentId: "reviewer",
    cost: { kind: "unknown", reason: "usage was not saved: disk full" },
    lost: "disk full",
    runId: launched.id,
    scope: "run",
  });
  expect(lost?.tokens).toBeUndefined();
  expect(
    warnings.some((line) => line.includes("a marker records the missing turn"))
  ).toBe(true);
  const total = totalOf(facts);
  expect(total).toMatchObject({ missing: 1, turns: 2 });
  expect(costLabel(total)).toContain("1 not recorded");
  expect(tokensLabel(total)).toContain("1 not recorded");

  expect(totalOf((await reread()).facts)).toMatchObject({
    missing: 1,
    turns: 2,
  });
});

it("when the fact and its marker both fail, a new engine over the same disk finds the turn in the durable transcript, claims it for no run, and says the run's total may be incomplete", async () => {
  const sessions = state;
  const reviewer = agent({ name: "reviewer", prompt: "Review." });
  let sessionId = "";
  step("two").do(async ({ agents }) => {
    const session = await agents.session(reviewer);
    sessionId = session.ref.id;
    await session.generate("first");
    await session.generate("second");
    return "done";
  });
  const first = await startEngine({
    print: () => undefined,
    sessions: durableSessions(sessions),
    state,
    usageStore: await failingUsage((write) => write === 2 || write === 3),
  });
  const launched = await first.launch<string>("two", {});
  await expect(launched.result).resolves.toBe("done");
  expect(await first.usage.read()).toMatchObject({ unsaved: 1 });
  await first.dispose();

  expect(totalOf((await reread()).facts)).toMatchObject({
    missing: 0,
    turns: 1,
  });
  await reportStored(launched.id);

  catalog.reset();
  const second = await startEngine({
    print: () => undefined,
    sessions: durableSessions(sessions),
    state,
  });
  engines.push(second);
  const records = await second.readUsage();
  expect(records).toMatchObject({ recovered: 1, unreadable: 0, unsaved: 0 });
  const recovered = records.facts.find((fact) => fact.lost !== undefined);
  expect(recovered).toMatchObject({
    agentId: UNATTRIBUTED,
    cost: { kind: "unknown" },
    lost: RECOVERED,
    scope: "unattributed",
    sessionId,
  });
  expect(recovered).not.toHaveProperty("runId");
  expect(recovered?.tokens?.total).toBeGreaterThan(0);
  const snapshot = dashboardSnapshot(await second.runs(), {
    definitions: second.definitions(),
    lastFinish: new Map(),
    monitors: second.monitors(),
    root: state,
    schedules: [],
    startedAt: 0,
    status: "",
    usage: records,
    workspaceId: "test",
  });
  const run = snapshot.runs.find((item) => item.id === launched.id);
  expect(run?.usage).toMatchObject({ turns: 1, unattributed: 1 });
  expect(costLabel(run?.usage)).toBe(
    "$2.00 reported · may be incomplete: 1 unattributed turn"
  );
  expect(
    costLabel(
      snapshot.usage?.byWorkflow.find((group) => group.id === "two")?.total
    )
  ).toBe("$2.00 reported · may be incomplete: 1 unattributed turn");
  expect(snapshot.usage?.total).toMatchObject({ missing: 1, turns: 2 });
  expect(tokensLabel(snapshot.usage?.total)).toContain(
    "· 2 turns · 1 not recorded"
  );
  expect(snapshot.usage?.recovered).toBe(1);
});

const NO_RECORDS = {
  facts: [],
  recovered: 0,
  unreadable: 0,
  unreadableAt: { direct: 0, runs: new Map<string, number>(), unowned: 0 },
  unsaved: 0,
  unsavedTurns: new Set<string>(),
};

async function reader(sessions: SessionStore = durableSessions(state)) {
  catalog.reset();
  const engine = await startEngine({
    print: () => undefined,
    sessions,
    state,
  });
  engines.push(engine);
  return engine;
}

function snapshotOf(
  engine: Engine,
  records: Awaited<ReturnType<Engine["readUsage"]>>,
  runs: Awaited<ReturnType<Engine["runs"]>>
) {
  return dashboardSnapshot(runs, {
    definitions: engine.definitions(),
    lastFinish: new Map(),
    monitors: engine.monitors(),
    root: state,
    schedules: [],
    startedAt: 0,
    status: "",
    usage: records,
    workspaceId: "test",
  });
}

it("a separate reader sees a direct session's committed but unrecorded turn at once, unattributed, and a turn appended after it cached the transcript on its next read", async () => {
  const writer = await startEngine({
    print: () => undefined,
    sessions: durableSessions(state),
    state,
    usageStore: await failingUsage((write) => write >= 2),
  });
  engines.push(writer);
  const helper = agent({ name: "helper", prompt: "Help." });
  const session = await writer.agents.session(helper);
  await session.generate("one");
  await session.generate("two");
  const second = await reader();
  const first = await second.readUsage();
  expect(first).toMatchObject({ recovered: 1, unreadable: 0 });
  const recovered = first.facts.find((fact) => fact.lost !== undefined);
  expect(recovered).toMatchObject({
    agentId: UNATTRIBUTED,
    lost: RECOVERED,
    scope: "unattributed",
    sessionId: session.ref.id,
  });
  expect(recovered?.tokens?.total).toBeGreaterThan(0);
  const { usage } = workspaceUsage(first, "test");
  expect(usage.total).toMatchObject({ missing: 1, turns: 2 });
  expect(usage.outsideRuns).toMatchObject({
    missing: 0,
    turns: 1,
    unattributed: 1,
  });
  await session.generate("three");
  const next = await second.readUsage();
  expect(next.recovered).toBe(2);
  expect(totalOf(next.facts)).toMatchObject({ missing: 2, turns: 3 });
});

it("a transcript that failed to read is read again at the same stamp, keeps only what recovery reads, and a running run's missing session is unreadable", async () => {
  const committed = message("m", {
    metadata: { ...message("m").metadata, output: { large: "x".repeat(1000) } },
    parts: [{ text: "x".repeat(1000), type: "text" }],
    sessionId: "s",
  });
  const { id, metadata, sessionId, updatedAt } = committed;
  const { model, timing, usage } = metadata ?? {};
  expect(transcriptTurn(committed)).toEqual({
    id,
    metadata: { model, timing, usage },
    sessionId,
    updatedAt,
  });
  let reads = 0;
  let stamp: string | null = "unchanged";
  let fail = false;
  const sessions = new InMemorySessionStore();
  await new Sessions({ store: sessions }).createSession({ id: "s" });
  const evidence = new UsageEvidence({
    recordedOf: () =>
      Promise.resolve({
        ledger: { "marbles:flow|agents.session|0": { id: "deleted" } },
      }),
    sessions: Object.assign(sessions, {
      listMessages: () => {
        reads += 1;
        return reads === 1 || fail
          ? Promise.reject(new Error("transient"))
          : Promise.resolve([committed]);
      },
    }),
    stamps: () => [{ id: "s", stamp }],
  });
  const failed = await evidence.unrecorded(NO_RECORDS, [], "ws");
  expect(failed.unreadable.unowned).toBe(1);
  const read = await evidence.unrecorded(NO_RECORDS, [], "ws");
  expect(read.unreadable.unowned).toBe(0);
  expect(read.facts.map((fact) => fact.turnId)).toEqual(["m"]);
  stamp = null;
  fail = true;
  expect(
    (await evidence.unrecorded(NO_RECORDS, [], "ws")).unreadable.unowned
  ).toBe(1);
  stamp = "unchanged";
  expect(
    (await evidence.unrecorded(NO_RECORDS, [], "ws")).unreadable.unowned
  ).toBe(1);
  fail = false;
  expect((await evidence.unrecorded(NO_RECORDS, [], "ws")).facts).toHaveLength(
    1
  );
  await evidence.unrecorded(NO_RECORDS, [], "ws");
  expect(reads).toBe(5);
  const running: ReconciledRun = {
    active: true,
    createdAt: 0,
    definition: "flow",
    id: "r",
    status: "running",
  };
  const live = await evidence.unrecorded(NO_RECORDS, [running], "ws");
  expect(live.unreadable.unowned).toBe(1);
});

it("an unreadable or missing transcript a settled run names is owned by nothing: its total, and every other, says it may be incomplete instead of restoring the surviving price as whole", async () => {
  const reviewer = agent({ name: "reviewer", prompt: "Review." });
  let sessionId = "";
  step("two").do(async ({ agents }) => {
    const session = await agents.session(reviewer);
    sessionId = session.ref.id;
    await session.generate("first");
    await session.generate("second");
    return "done";
  });
  const writer = await startEngine({
    print: () => undefined,
    sessions: durableSessions(state),
    state,
    usageStore: await failingUsage((write) => write === 2 || write === 3),
  });
  const launched = await writer.launch<string>("two", {});
  await expect(launched.result).resolves.toBe("done");
  await writer.dispose();
  await reportStored(launched.id);
  const transcript = transcriptOf(state, sessionId);
  await transcript.damage();

  const second = await reader();
  const records = await second.readUsage();
  expect(records).toMatchObject({ recovered: 0, unreadable: 1 });
  expect(records.unreadableAt).toEqual({
    direct: 0,
    runs: new Map(),
    unowned: 1,
  });
  const snapshot = snapshotOf(second, records, await second.runs());
  const run = snapshot.runs.find((item) => item.id === launched.id);
  expect(costLabel(run?.usage)).toBe(
    "$2.00 reported · may be incomplete: 1 unreadable usage record"
  );
  expect(
    costLabel(
      snapshot.usage?.byWorkflow.find((group) => group.id === "two")?.total
    )
  ).toBe("$2.00 reported · may be incomplete: 1 unreadable usage record");
  expect(costLabel(snapshot.usage?.outsideRuns)).toBe(
    "unknown · 1 unreadable usage record may belong here"
  );

  await transcript.remove();
  const third = await reader();
  expect((await third.readUsage()).unreadableAt).toEqual({
    direct: 0,
    runs: new Map(),
    unowned: 1,
  });
  const evidence = new UsageEvidence({
    recordedOf: () => Promise.resolve("unreadable"),
    sessions: new InMemorySessionStore(),
  });
  const run2: ReconciledRun = {
    active: false,
    createdAt: 0,
    definition: "two",
    id: launched.id,
    status: "complete",
  };
  const found = await evidence.unrecorded(NO_RECORDS, [run2], "test");
  expect(found.unreadable.runs.get(launched.id)).toBe(1);
});

it("a direct session none of whose usage was saved is found through the store's listing, as unattributed consumption beside other direct sessions", async () => {
  const writer = await startEngine({
    print: () => undefined,
    sessions: durableSessions(state),
    state,
    usageStore: await failingUsage((write) => write === 2 || write === 3),
  });
  const helper = agent({ name: "helper", prompt: "Help." });
  const kept = await writer.agents.session(helper);
  await kept.generate("saved one");
  const orphan = await writer.agents.session(helper);
  await orphan.generate("fact and marker both fail");
  await kept.generate("saved two");
  await writer.dispose();
  const ledger = await reread();
  expect(ledger.facts.some((fact) => fact.sessionId === orphan.ref.id)).toBe(
    false
  );

  const second = await reader();
  const records = await second.readUsage();
  expect(records.recovered).toBe(1);
  const found = records.facts.find((fact) => fact.sessionId === orphan.ref.id);
  expect(found).toMatchObject({
    agentId: UNATTRIBUTED,
    lost: RECOVERED,
    scope: "unattributed",
  });
  expect(found?.tokens?.total).toBeGreaterThan(0);
  const { usage } = workspaceUsage(records, "test");
  expect(usage.total).toMatchObject({ missing: 1, turns: 3 });
  expect(usage.unattributed).toBe(1);
  expect(usage.outsideRuns).toMatchObject({ turns: 2, unattributed: 1 });
  expect(costLabel(usage.outsideRuns)).toContain(
    "may be incomplete: 1 unattributed turn"
  );
  const elsewhere = await mkdtemp(join(tmpdir(), "marbles-usage-other-"));
  try {
    catalog.reset();
    const other = await startEngine({
      print: () => undefined,
      sessions: durableSessions(elsewhere),
      state: elsewhere,
    });
    engines.push(other);
    expect((await other.readUsage()).facts).toEqual([]);
  } finally {
    await rm(elsewhere, { force: true, recursive: true });
  }
});

it("a direct session none of whose usage was saved is found through the database store's listing too", async () => {
  const machine = await testMachine();
  const sessionsOf = (scope: string) =>
    new DatabaseSessionStore({ database: machine.database.database, scope });
  const owned: Engine[] = [];
  try {
    const writer = await startEngine({
      print: () => undefined,
      sessions: sessionsOf("test"),
      state,
      usageStore: await failingUsage((write) => write === 2 || write === 3),
    });
    owned.push(writer);
    const helper = agent({ name: "helper", prompt: "Help." });
    const kept = await writer.agents.session(helper);
    await kept.generate("saved one");
    const orphan = await writer.agents.session(helper);
    await orphan.generate("fact and marker both fail");
    await kept.generate("saved two");
    await writer.dispose();

    catalog.reset();
    const second = await startEngine({
      print: () => undefined,
      sessions: sessionsOf("test"),
      state,
    });
    owned.push(second);
    const records = await second.readUsage();
    expect(records.recovered).toBe(1);
    expect(
      records.facts.find((fact) => fact.sessionId === orphan.ref.id)
    ).toMatchObject({ agentId: UNATTRIBUTED, lost: RECOVERED });
    expect(records.unreadableAt.unowned).toBe(0);
    catalog.reset();
    const other = await startEngine({
      print: () => undefined,
      sessions: sessionsOf("other"),
      state: temporaryDirectory("marbles-usage-other-"),
    });
    owned.push(other);
    expect((await other.readUsage()).facts).toEqual([]);
  } finally {
    await Promise.all(owned.map((engine) => engine.dispose()));
    machine.close();
  }
});

it("a direct turn in a session a workflow only continued is not claimed by the overlapping run", async () => {
  const helper = agent({ name: "helper", prompt: "Help." });
  let continued: SessionRef | undefined;
  let release: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let opened: () => void = () => undefined;
  const ready = new Promise<void>((resolve) => {
    opened = resolve;
  });
  step("continues").do(async ({ agents }) => {
    await agents.session(helper, continued ? { session: continued } : {});
    opened();
    await gate;
    return "no compute";
  });
  const writer = await startEngine({
    print: () => undefined,
    sessions: durableSessions(state),
    state,
    usageStore: await failingUsage((write) => write === 2 || write === 3),
  });
  const direct = await writer.agents.session(helper);
  await direct.generate("saved direct turn");
  continued = direct.ref;
  const launched = await writer.launch<string>("continues", {});
  await ready;
  await direct.generate("direct turn while the run waits");
  release();
  await expect(launched.result).resolves.toBe("no compute");
  await writer.dispose();

  const second = await reader();
  const records = await second.readUsage();
  expect(records.recovered).toBe(1);
  const found = records.facts.find((fact) => fact.lost !== undefined);
  expect(found).toMatchObject({
    scope: "unattributed",
    sessionId: direct.ref.id,
  });
  expect(found).not.toHaveProperty("runId");
  const snapshot = snapshotOf(second, records, await second.runs());
  const run = snapshot.runs.find((item) => item.id === launched.id);
  expect(run?.usage).toMatchObject({ turns: 0, unattributed: 1 });
  expect(costLabel(run?.usage)).toBe(
    "unknown · 1 unattributed turn may belong here"
  );
  expect(snapshot.usage?.outsideRuns).toMatchObject({
    turns: 1,
    unattributed: 1,
  });
  expect(snapshot.usage?.total).toMatchObject({ missing: 1, turns: 2 });
});

it("a saved marker's own attribution goes to the recovered leaf, which replaces it: direct in a continued session, the step in a run", async () => {
  const helper = agent({ name: "helper", prompt: "Help." });
  let continued: SessionRef | undefined;
  let release: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let opened: () => void = () => undefined;
  const ready = new Promise<void>((resolve) => {
    opened = resolve;
  });
  step("continues").do(async ({ agents }) => {
    await agents.session(helper, continued ? { session: continued } : {});
    opened();
    await gate;
    return "no compute";
  });
  step("computes").do(async ({ agents }) => {
    const session = await agents.session(helper);
    await session.generate("only its marker saves");
    await session.generate("saved");
    return "done";
  });
  const writer = await startEngine({
    print: () => undefined,
    sessions: durableSessions(state),
    state,
    usageStore: await failingUsage((write) => write === 2 || write === 4),
  });
  const direct = await writer.agents.session(helper);
  await direct.generate("saved direct turn");
  continued = direct.ref;
  const waiting = await writer.launch<string>("continues", {});
  await ready;
  await direct.generate("direct turn whose marker saves");
  release();
  await expect(waiting.result).resolves.toBe("no compute");
  const computing = await writer.launch<string>("computes", {});
  await expect(computing.result).resolves.toBe("done");
  await writer.dispose();

  const second = await reader();
  const records = await second.readUsage();
  expect(records.recovered).toBe(2);
  const lost = records.facts.filter((fact) => fact.lost !== undefined);
  expect(lost).toHaveLength(2);
  expect(lost.every((fact) => fact.lost === RECOVERED)).toBe(true);
  expect(lost.every((fact) => (fact.tokens?.total ?? 0) > 0)).toBe(true);
  expect(lost.find((fact) => fact.sessionId === direct.ref.id)).toMatchObject({
    agentId: "helper",
    scope: "direct",
  });
  expect(lost.find((fact) => fact.scope === "run")).toMatchObject({
    agentId: "helper",
    path: ["computes"],
    runId: computing.id,
  });
  const { usage } = workspaceUsage(records, "test");
  expect(usage.unattributed).toBe(0);
  expect(usage.outsideRuns).toMatchObject({ missing: 1, turns: 2 });
  expect(usage.total).toMatchObject({ missing: 2, turns: 4 });
});

it("attributes a run's turn only on per-turn proof, a one-turn call's message, never on the session it was filed under or the run's window", async () => {
  const sessions = new InMemorySessionStore();
  const written = new Sessions({ store: sessions });
  expect(
    ledgerNames({
      "marbles:flow.a.b|agent.turn|0": {
        agent: "writer",
        message: "m",
        path: ["flow", "a.b"],
        session: "s",
      },
      "marbles:flow.a.b|agent.turn|1": { message: "legacy", session: "s" },
      "marbles:flow|agent.turn|0": { message: "root", session: "s" },
      "marbles:flow|agents.session|0": { id: "opened", provider: "p" },
      "marbles:flow|artifact|0": { id: "not-a-session" },
    })
  ).toEqual({
    sessions: new Set(["s", "opened"]),
    turns: new Map([
      ["m", { agent: "writer", path: ["flow", "a.b"] }],
      ["legacy", { path: [] }],
      ["root", { path: ["flow"] }],
    ]),
  });
  const turn = (sessionId: string, completedAt = Date.now() - 1000) =>
    written.appendMessage({
      metadata: {
        timing: {
          completedAt,
          durationMs: 1,
          startedAt: completedAt - 1,
        },
        usage: { inputTokens: 2, outputTokens: 3, totalTokens: 5 },
      },
      parts: [],
      role: "assistant",
      sessionId,
    });
  await written.createSession({ id: "run-session", title: "run" });
  await written.createSession({
    id: "opened",
    parentSessionId: "run-session",
  });
  await written.createSession({
    id: "one-turn",
    parentSessionId: "run-session",
  });
  await written.createSession({ id: "continued" });
  await written.createSession({
    id: "child",
    parentSessionId: "opened",
    recursionDepth: 1,
  });
  await written.appendMessage({
    parts: [],
    role: "user",
    sessionId: "opened",
  });
  await turn("opened");
  const call = await turn("one-turn");
  const legacy = await turn("one-turn");
  await turn("continued");
  await turn("child");
  const recorded = {
    ledger: {
      "marbles:flow.a.b|agent.turn|0": {
        agent: "writer",
        message: call.id,
        path: ["flow", "a.b"],
        session: "one-turn",
      },
      "marbles:flow.a.b|agent.turn|1": {
        message: legacy.id,
        session: "one-turn",
      },
      "marbles:flow|agents.session|0": { id: "opened", provider: "p" },
      "marbles:flow|agents.session|1": { id: "continued", provider: "p" },
    },
    session: "run-session",
  };
  const run: ReconciledRun = {
    active: false,
    createdAt: Date.now() - 60_000,
    definition: "flow",
    id: "run-1",
    status: "complete",
  };
  const stamps = () =>
    ["run-session", "opened", "one-turn", "continued", "child"].map((id) => ({
      id,
      stamp: null,
    }));
  const evidence = new UsageEvidence({
    recordedOf: () => Promise.resolve(recorded),
    sessions,
    stamps,
  });
  const later = usageFact(
    {
      message: await turn("one-turn"),
      route: {},
      source: { agentId: "later" },
      workspaceId: "ws",
    },
    () => undefined
  );
  const { facts, unreadable } = await evidence.unrecorded(
    { ...NO_RECORDS, facts: [later] },
    [run],
    "ws"
  );
  expect(unreadable).toEqual({ runs: new Map(), unowned: 0 });
  const byTurn = new Map(facts.map((fact) => [fact.turnId, fact]));
  expect(byTurn.get(call.id)).toMatchObject({
    agentId: "writer",
    path: ["flow", "a.b"],
    runId: "run-1",
    scope: "run",
  });
  expect(byTurn.get(legacy.id)).toMatchObject({
    agentId: UNATTRIBUTED,
    path: [],
    runId: "run-1",
  });
  const bySession = new Map(facts.map((fact) => [fact.sessionId, fact]));
  expect(bySession.get("opened")).toMatchObject({ scope: "unattributed" });
  expect(bySession.get("continued")).toMatchObject({ scope: "unattributed" });
  expect(bySession.get("child")).toMatchObject({ scope: "unattributed" });
  expect(facts).toHaveLength(5);
  const running = new UsageEvidence({
    recordedOf: () => Promise.resolve(recorded),
    sessions,
    stamps,
  });
  const recording = await turn("opened", Date.now());
  const live = await running.unrecorded(
    NO_RECORDS,
    [{ ...run, active: true, status: "running" }],
    "ws"
  );
  expect(live.facts.map((fact) => fact.sessionId).sort()).toEqual([
    "child",
    "continued",
    "one-turn",
    "one-turn",
    "one-turn",
    "opened",
    "opened",
  ]);
  expect(live.facts.map((fact) => fact.turnId)).toContain(recording.id);
  expect(live.facts.every((fact) => fact.scope === "unattributed")).toBe(true);
});

function gated() {
  let release: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let opened: () => void = () => undefined;
  const ready = new Promise<void>((resolve) => {
    opened = resolve;
  });
  return { gate, opened: () => opened(), ready, release: () => release() };
}

it("a one-turn call whose usage was lost is recovered for its own agent and its step, even one named with a dot", async () => {
  const writer = agent({ name: "writer", prompt: "Write." });
  step("docs.v2").do(async () => (await writer.generate("one turn")).text);
  const first = await startEngine({
    print: () => undefined,
    sessions: durableSessions(state),
    state,
    usageStore: await failingUsage(() => true),
  });
  const launched = await first.launch<string>("docs.v2", {});
  await launched.result;
  await first.dispose();
  const records = await (await reader()).readUsage();
  expect(records.facts).toEqual([
    expect.objectContaining({
      agentId: "writer",
      lost: RECOVERED,
      path: ["docs.v2"],
      runId: launched.id,
    }),
  ]);
});

it("a turn the host takes directly in a session a run opened is not claimed by that run after a restart", async () => {
  const helper = agent({ name: "helper", prompt: "Help." });
  const wait = gated();
  let ref: SessionRef | undefined;
  step("opens").do(async ({ agents }) => {
    const session = await agents.session(helper);
    ({ ref } = session);
    await session.generate("saved in the run");
    wait.opened();
    await wait.gate;
    return "done";
  });
  const writer = await startEngine({
    print: () => undefined,
    sessions: durableSessions(state),
    state,
    usageStore: await failingUsage((write) => write >= 2),
  });
  const launched = await writer.launch<string>("opens", {});
  await wait.ready;
  if (!ref) {
    throw new Error("the run opened no session");
  }
  const direct = await writer.agents.session(helper, { session: ref });
  await direct.generate("direct turn while the run waits");
  wait.release();
  await expect(launched.result).resolves.toBe("done");
  await writer.dispose();

  const second = await reader();
  const records = await second.readUsage();
  expect(records).toMatchObject({ recovered: 1, unreadable: 0 });
  const found = records.facts.find((fact) => fact.lost !== undefined);
  expect(found).toMatchObject({ scope: "unattributed", sessionId: ref.id });
  expect(found).not.toHaveProperty("runId");
  expect(found?.tokens?.total).toBeGreaterThan(0);
  const snapshot = snapshotOf(second, records, await second.runs());
  const run = snapshot.runs.find((item) => item.id === launched.id);
  expect(run?.usage).toMatchObject({ missing: 0, turns: 1, unattributed: 1 });
  expect(run?.steps[0]?.usage?.direct).toMatchObject({
    turns: 1,
    unattributed: 1,
  });
  expect(snapshot.usage?.outsideRuns).toMatchObject({
    turns: 0,
    unattributed: 1,
  });
  expect(snapshot.usage?.total).toMatchObject({ missing: 1, turns: 2 });
});

it("a workflow continuing another workflow's session keeps its unrecorded turn: it may belong to either, and is claimed by neither", async () => {
  const helper = agent({ name: "helper", prompt: "Help." });
  const wait = gated();
  let ref: SessionRef | undefined;
  let failing = false;
  step("creator").do(async ({ agents }) => {
    const session = await agents.session(helper);
    ({ ref } = session);
    await session.generate("saved");
    failing = true;
    await session.generate("fact and marker both fail");
    wait.opened();
    await wait.gate;
    return "created";
  });
  step("consumer").do(async ({ agents }) => {
    if (!ref) {
      throw new Error("no session to continue");
    }
    const session = await agents.session(helper, { session: ref });
    await session.generate("the consumer's turn, fact and marker both fail");
    return "consumed";
  });
  const sessions = durableSessions(state);
  const usageStore = await failingUsage(() => failing);
  const first = await startEngine({
    print: () => undefined,
    sessions,
    state,
    usageStore,
  });
  const creating = await first.launch<string>("creator", {});
  await wait.ready;
  const other = await startEngine({
    print: () => undefined,
    sessions,
    state,
    usageStore,
  });
  const consuming = await other.launch<string>("consumer", {});
  await expect(consuming.result).resolves.toBe("consumed");
  await other.dispose();
  wait.release();
  await expect(creating.result).resolves.toBe("created");
  await first.dispose();

  const second = await reader();
  const records = await second.readUsage();
  expect(records).toMatchObject({ recovered: 2, unreadable: 0 });
  const lost = records.facts.filter((fact) => fact.lost !== undefined);
  expect(lost.every((fact) => fact.scope === "unattributed")).toBe(true);
  const inRuns = records.facts.filter((fact) => fact.scope === "run");
  expect(inRuns).toHaveLength(1);
  expect(inRuns[0]).toMatchObject({ runId: creating.id });
  expect(inRuns[0]).not.toHaveProperty("lost");
  const snapshot = snapshotOf(second, records, await second.runs());
  const usageOf = (id: string) =>
    snapshot.runs.find((item) => item.id === id)?.usage;
  expect(usageOf(creating.id)).toMatchObject({ turns: 1, unattributed: 2 });
  expect(usageOf(consuming.id)).toMatchObject({ turns: 0, unattributed: 1 });
  expect(costLabel(usageOf(consuming.id))).toBe(
    "unknown · 1 unattributed turn may belong here"
  );
  const workflow = snapshot.usage?.byWorkflow.find(
    (group) => group.id === "consumer"
  );
  expect(costLabel(workflow?.total)).toBe(
    "unknown · 2 unattributed turns may belong here"
  );
});

it("a direct session a workflow continues in another engine, whose fact and marker both fail, is not claimed as direct by a fresh reader, and the workflow says the turn may be its, even once the transcript cannot be read", async () => {
  const helper = agent({ name: "helper", prompt: "Help." });
  const wait = gated();
  let ref: SessionRef | undefined;
  const consumer = () =>
    step("consumer").do(async ({ agents }) => {
      if (ref) {
        const session = await agents.session(helper, { session: ref });
        await session.generate(
          "the workflow's turn, fact and marker both fail"
        );
        wait.opened();
        await wait.gate;
      }
      return "consumed";
    });
  consumer();
  const sessions = durableSessions(state);
  const host = await started({ sessions, state });
  const direct = await host.agents.session(helper);
  await direct.generate("saved direct turn");
  ({ ref } = direct);
  const transcript = transcriptOf(state, direct.ref.id);
  const fresh = async () => {
    catalog.reset();
    consumer();
    return await started({
      sessions: durableSessions(state),
      state,
    });
  };
  const labelOf = (
    snapshot: ReturnType<typeof snapshotOf>,
    id: string
  ): string =>
    costLabel(
      snapshot.usage?.byWorkflow.find((group) => group.id === id)?.total
    );
  try {
    const workflowEngine = await started({
      sessions,
      state,
      usageStore: await failingUsage(() => true),
    });
    const consuming = await workflowEngine.launch<string>("consumer", {});
    await wait.ready;
    const messages = await sessions.listMessages(direct.ref.id);
    const turns = messages.filter(
      (item) => item.role === "assistant" && item.metadata?.usage
    );
    expect(turns).toHaveLength(2);
    expect((await reread()).facts.map((fact) => fact.sessionId)).toEqual([
      direct.ref.id,
    ]);
    const [savedTurn, lostTurn] = turns;
    const tokensOf = (turn: SessionMessage | undefined) =>
      turn?.metadata?.usage?.totalTokens ?? 0;

    const active = await fresh();
    expect(await active.runs()).toEqual([]);
    const records = await active.readUsage();
    expect(records).toMatchObject({ recovered: 1, unreadable: 0 });
    const found = records.facts.find((fact) => fact.turnId === lostTurn?.id);
    expect(found).toMatchObject({
      agentId: UNATTRIBUTED,
      lost: RECOVERED,
      scope: "unattributed",
      sessionId: direct.ref.id,
    });
    expect(found).not.toHaveProperty("runId");
    expect(found).not.toHaveProperty("path");
    expect(found?.tokens?.total).toBe(tokensOf(lostTurn));
    expect(records.facts.some((fact) => fact.scope === "run")).toBe(false);
    const snapshot = snapshotOf(active, records, await active.runs());
    expect(snapshot.usage?.total).toMatchObject({
      missing: 1,
      tokens: { total: tokensOf(savedTurn) + tokensOf(lostTurn) },
      turns: 2,
    });
    expect(snapshot.usage?.outsideRuns).toMatchObject({
      missing: 0,
      turns: 1,
      unattributed: 1,
    });
    expect(costLabel(snapshot.usage?.outsideRuns)).toContain(
      "may be incomplete: 1 unattributed turn"
    );
    expect(labelOf(snapshot, "consumer")).toBe(
      "unknown · 1 unattributed turn may belong here"
    );

    await transcript.damage();
    const blind = await fresh();
    const unread = await blind.readUsage();
    expect(unread).toMatchObject({ recovered: 0, unreadable: 1 });
    expect(unread.unreadableAt).toEqual({
      direct: 0,
      runs: new Map(),
      unowned: 1,
    });
    expect(unread.facts.map((fact) => fact.turnId)).toEqual([savedTurn?.id]);
    const blindSnapshot = snapshotOf(blind, unread, await blind.runs());
    expect(blindSnapshot.usage?.total).toMatchObject({
      missing: 0,
      tokens: { total: tokensOf(savedTurn) },
      turns: 1,
      unreadable: 1,
    });
    expect(costLabel(blindSnapshot.usage?.outsideRuns)).toContain(
      "may be incomplete: 1 unreadable usage record"
    );
    expect(labelOf(blindSnapshot, "consumer")).toBe(
      "unknown · 1 unreadable usage record may belong here"
    );
    await transcript.restore();

    wait.release();
    await expect(consuming.result).resolves.toBe("consumed");
    await workflowEngine.dispose();

    const settled = await fresh();
    const after = await settled.readUsage();
    expect(
      after.facts.find((fact) => fact.turnId === lostTurn?.id)
    ).toMatchObject({ scope: "unattributed" });
    const settledSnapshot = snapshotOf(settled, after, await settled.runs());
    const run = settledSnapshot.runs.find((item) => item.id === consuming.id);
    expect(run?.usage).toMatchObject({ turns: 0, unattributed: 1 });
    expect(costLabel(run?.steps[0]?.usage?.inclusive)).toBe(
      "unknown · 1 unattributed turn may belong here"
    );
    expect(labelOf(settledSnapshot, "consumer")).toBe(
      "unknown · 1 unattributed turn may belong here"
    );
  } finally {
    await transcript.restore();
    wait.release();
  }
});

it("a session one settled run names, which a workflow in another engine continues with its fact and marker both failing, warns that workflow, not only the run, when the transcript cannot be read", async () => {
  const helper = agent({ name: "helper", prompt: "Help." });
  const wait = gated();
  let ref: SessionRef | undefined;
  const define = () => {
    step("producer").do(async ({ agents }) => {
      const session = await agents.session(helper);
      ({ ref } = session);
      await session.generate("the producer's saved turn");
      return "produced";
    });
    step("consumer").do(async ({ agents }) => {
      if (ref) {
        const session = await agents.session(helper, { session: ref });
        await session.generate(
          "the consumer's turn, fact and marker both fail"
        );
        wait.opened();
        await wait.gate;
      }
      return "consumed";
    });
  };
  define();
  const sessions = durableSessions(state);
  const host = await started({ sessions, state });
  const producing = await host.launch<string>("producer", {});
  await expect(producing.result).resolves.toBe("produced");
  if (!ref) {
    throw new Error("the producer opened no session");
  }
  const transcript = transcriptOf(state, ref.id);
  const fresh = async () => {
    catalog.reset();
    define();
    return await started({
      sessions: durableSessions(state),
      state,
    });
  };
  try {
    const workflowEngine = await started({
      sessions,
      state,
      usageStore: await failingUsage(() => true),
    });
    const consuming = await workflowEngine.launch<string>("consumer", {});
    await wait.ready;
    expect(
      (await reread()).facts.map((fact) =>
        fact.scope === "run" ? fact.runId : undefined
      )
    ).toEqual([producing.id]);
    await transcript.damage();
    await expect(durableSessions(state).listMessages(ref.id)).rejects.toThrow();

    const blind = await fresh();
    expect((await blind.runs()).map((item) => item.id)).toEqual([producing.id]);
    const records = await blind.readUsage();
    expect(records).toMatchObject({ recovered: 0, unreadable: 1 });
    expect(records.unreadableAt).toEqual({
      direct: 0,
      runs: new Map(),
      unowned: 1,
    });
    expect(records.facts).toHaveLength(1);
    expect(records.facts[0]).toMatchObject({
      runId: producing.id,
      scope: "run",
    });
    const snapshot = snapshotOf(blind, records, await blind.runs());
    const workflowLabel = (id: string) =>
      costLabel(
        snapshot.usage?.byWorkflow.find((group) => group.id === id)?.total
      );
    expect(workflowLabel("consumer")).toBe(
      "unknown · 1 unreadable usage record may belong here"
    );
    expect(workflowLabel("producer")).toBe(
      "unknown · 1 turn unpriced · may be incomplete: 1 unreadable usage record"
    );
    const run = snapshot.runs.find((item) => item.id === producing.id);
    expect(run?.usage).toMatchObject({ turns: 1, unreadable: 1 });
    expect(costLabel(snapshot.usage?.outsideRuns)).toBe(
      "unknown · 1 unreadable usage record may belong here"
    );
    expect(snapshot.usage?.total).toMatchObject({ turns: 1, unreadable: 1 });

    await transcript.restore();
    wait.release();
    await expect(consuming.result).resolves.toBe("consumed");
  } finally {
    await transcript.restore();
    wait.release();
  }
});

it("damaged stored facts stay with the owner they are filed under: a run's with that run, a direct session's outside runs, and an unrelated workflow stays empty", async () => {
  const reviewer = agent({ name: "reviewer", prompt: "Review." });
  const define = () => {
    step("priced").do(async ({ agents }) => {
      const session = await agents.session(reviewer);
      await session.generate("one");
      return "done";
    });
    step("unrelated").do(() => "no compute");
  };
  define();
  const writer = await started({
    sessions: durableSessions(state),
    state,
  });
  const launched = await writer.launch<string>("priced", {});
  await expect(launched.result).resolves.toBe("done");
  const [saved] = (await reread()).facts;
  await putStoredFact(state, {
    runId: launched.id,
    turnId: "x",
    value: { ...saved, cost: { amount: "bad" }, turnId: "x" },
  });
  await putStoredFact(state, { runId: null, turnId: "gone", value: "{broken" });

  catalog.reset();
  define();
  const second = await started({
    sessions: durableSessions(state),
    state,
  });
  const records = await second.readUsage();
  expect(records).toMatchObject({ recovered: 0, unreadable: 2 });
  expect(records.unreadableAt).toEqual({
    direct: 1,
    runs: new Map([[launched.id, 1]]),
    unowned: 0,
  });
  const snapshot = snapshotOf(second, records, await second.runs());
  const workflow = (id: string) =>
    snapshot.usage?.byWorkflow.find((group) => group.id === id)?.total;
  expect(costLabel(workflow("priced"))).toContain(
    "may be incomplete: 1 unreadable usage record"
  );
  expect(workflow("unrelated")).toBeUndefined();
  expect(costLabel(snapshot.usage?.outsideRuns)).toBe(
    "unknown · 1 unreadable usage record may belong here"
  );
});

it("one damaged session entry does not hide a healthy orphan already found, or for a new reader, and the totals say they may be incomplete", async () => {
  const damage: { on: boolean } = { on: false };
  const damaged = () =>
    new ListingSessions(state, async (inner) => [
      ...(await inner.stamps()),
      ...(damage.on ? [{ id: "broken-loop", stamp: null }] : []),
    ]);
  const writer = await startEngine({
    print: () => undefined,
    sessions: durableSessions(state),
    state,
    usageStore: await failingUsage((write) => write === 2 || write === 3),
  });
  const helper = agent({ name: "helper", prompt: "Help." });
  const kept = await writer.agents.session(helper);
  await kept.generate("saved");
  const orphan = await writer.agents.session(helper);
  await orphan.generate("fact and marker both fail");
  await writer.dispose();

  const second = await reader(damaged());
  const before = await second.readUsage();
  expect(before).toMatchObject({ recovered: 1, unreadable: 0 });
  damage.on = true;
  const cached = await second.readUsage();
  const fresh = await (await reader(damaged())).readUsage();
  for (const records of [cached, fresh]) {
    expect(records).toMatchObject({ recovered: 1, unreadable: 1 });
    expect(records.unreadableAt.unowned).toBe(1);
    expect(
      records.facts.find((fact) => fact.sessionId === orphan.ref.id)
    ).toMatchObject({ lost: RECOVERED, scope: "unattributed" });
    const { usage } = workspaceUsage(records, "test");
    expect(usage.total).toMatchObject({ missing: 1, turns: 2 });
    expect(costLabel(usage.outsideRuns)).toContain(
      "may be incomplete: 1 unreadable usage record, 1 unattributed turn"
    );
  }
});

class ListingSessions implements ListedSessionStore {
  readonly #inner: ListedSessionStore;
  readonly #listing: (
    inner: ListedSessionStore
  ) => readonly SessionStamp[] | Promise<readonly SessionStamp[]>;

  constructor(
    root: string,
    listing: (
      inner: ListedSessionStore
    ) => readonly SessionStamp[] | Promise<readonly SessionStamp[]>
  ) {
    this.#inner = durableSessions(root);
    this.#listing = listing;
  }

  commit(write: SessionStoreWrite) {
    return this.#inner.commit(write);
  }

  getMessage(id: string) {
    return this.#inner.getMessage(id);
  }

  getSession(id: string) {
    return this.#inner.getSession(id);
  }

  listMessages(sessionId: string) {
    return this.#inner.listMessages(sessionId);
  }

  stamps() {
    return this.#listing(this.#inner);
  }

  transaction<T>(work: (view: SessionStore) => Promise<T>) {
    return this.#inner.transaction?.(work) ?? work(this.#inner);
  }
}

it("a listing that fails on a new reader's first read still reads the named sessions, and every total, even an empty workflow's, says it may be incomplete", async () => {
  const helper = agent({ name: "helper", prompt: "Help." });
  step("idle").do(() => "no compute");
  const writer = await startEngine({
    print: () => undefined,
    sessions: durableSessions(state),
    state,
    usageStore: await failingUsage((write) => write === 2 || write === 3),
  });
  const kept = await writer.agents.session(helper);
  await kept.generate("saved");
  await kept.generate("fact and marker both fail");
  const idle = await writer.launch<string>("idle", {});
  await expect(idle.result).resolves.toBe("no compute");
  await writer.dispose();

  catalog.reset();
  step("idle").do(() => "no compute");
  const second = await startEngine({
    print: () => undefined,
    sessions: new ListingSessions(state, () => {
      throw new Error("EACCES: permission denied, scandir");
    }),
    state,
  });
  engines.push(second);
  const records = await second.readUsage();
  expect(records).toMatchObject({ recovered: 1, unreadable: 1 });
  expect(records.unreadableAt.unowned).toBe(1);
  const snapshot = snapshotOf(second, records, await second.runs());
  expect(snapshot.usage?.total).toMatchObject({ turns: 2, unreadable: 1 });
  expect(snapshot.usage?.outsideRuns).toMatchObject({
    turns: 1,
    unattributed: 1,
    unreadable: 1,
  });
  const run = snapshot.runs.find((item) => item.id === idle.id);
  expect(costLabel(run?.usage)).toBe(
    "unknown · 1 unreadable usage record may belong here"
  );
  expect(run?.steps[0]?.usage?.inclusive).toMatchObject({
    turns: 0,
    unreadable: 1,
  });
  const workflow = snapshot.usage?.byWorkflow.find(
    (group) => group.id === "idle"
  );
  expect(costLabel(workflow?.total)).toBe(
    "unknown · 1 unreadable usage record, 1 unattributed turn may belong here"
  );
});

it("labels a priced total with a lost turn as partial, never as whole", async () => {
  const ledger = new UsageLedger(new MemoryUsageStore());
  const saved = usageFact(
    { message: message("saved"), route: {}, source, workspaceId: "ws" },
    priced
  );
  await ledger.record(saved);
  const lostTurn = usageFact(
    { message: message("lost"), route: {}, source, workspaceId: "ws" },
    priced
  );
  const failing = new UsageLedger(
    new FailingUsageStore(new MemoryUsageStore(), () => true)
  );
  expect(await failing.record(lostTurn)).toMatchObject({ saved: "nothing" });
  const total = totalOf([saved, ...(await failing.read()).facts]);
  expect(costLabel(total)).toBe(
    "$4.50 est. · partial: 1 of 2 turns not recorded"
  );
});

it("a settled run's record that could not be read is read again, so a repair counts on the next read of the same engine", async () => {
  step("settles").do(() => "done");
  const writer = await started({
    sessions: durableSessions(state),
    state,
  });
  const launched = await writer.launch<string>("settles", {});
  await expect(launched.result).resolves.toBe("done");
  await writer.dispose();

  const second = await reader();
  await recordLedger(launched.id, sql`'[1]'`);
  const damaged = await second.readUsage();
  expect(damaged.unreadableAt.runs.get(launched.id)).toBe(1);
  await recordLedger(launched.id, sql`'{}'`);
  const repaired = await second.readUsage();
  expect(repaired).toMatchObject({ unreadable: 0 });
  expect(repaired.unreadableAt.runs.has(launched.id)).toBe(false);
});

async function recordLedger(runId: string, ledger: SQL): Promise<void> {
  const opened = await openDatabase(stateDatabase(state));
  if (opened === undefined) {
    throw new Error("no Marbles database");
  }
  try {
    await opened.database.run(
      sql`UPDATE marbles_workflow_runs SET ledger = ${ledger} WHERE scope = 'test' AND run_id = ${runId}`
    );
  } finally {
    opened.close();
  }
}

class UnlistedSessions implements SessionStore {
  readonly #inner: SessionStore;

  constructor(root: string) {
    this.#inner = durableSessions(root);
  }

  commit(write: SessionStoreWrite) {
    return this.#inner.commit(write);
  }

  getMessage(id: string) {
    return this.#inner.getMessage(id);
  }

  getSession(id: string) {
    return this.#inner.getSession(id);
  }

  listMessages(sessionId: string) {
    return this.#inner.listMessages(sessionId);
  }

  transaction<T>(work: (view: SessionStore) => Promise<T>) {
    return this.#inner.transaction?.(work) ?? work(this.#inner);
  }
}

it("a store that cannot list sessions and outlives the process says every total may be incomplete, since a session only a lost marker named is never found", async () => {
  const sessions = state;
  const helper = agent({ name: "helper", prompt: "Help." });
  const writer = await started({
    sessions: new UnlistedSessions(sessions),
    state,
    usageStore: await failingUsage((write) => write <= 2),
  });
  const orphan = await writer.agents.session(helper);
  await orphan.generate("fact and marker both fail");
  expect(await writer.readUsage()).toMatchObject({
    recovered: 1,
    unreadable: 1,
  });
  await writer.dispose();

  catalog.reset();
  const restarted = await started({
    sessions: new UnlistedSessions(sessions),
    state,
  });
  const records = await restarted.readUsage();
  expect(records).toMatchObject({ recovered: 0, unreadable: 1 });
  expect(records.unreadableAt).toEqual({
    direct: 0,
    runs: new Map(),
    unowned: 1,
  });
  expect(costLabel(workspaceUsage(records, "test").usage.total)).toBe(
    "unknown · 1 unreadable usage record may belong here"
  );
});

it("a session store or a ledger kept in memory loses nothing a restart could hide from the other, so neither warns", async () => {
  const helper = agent({ name: "helper", prompt: "Help." });
  const inMemorySessions = await started({
    sessions: new InMemorySessionStore(),
    state,
  });
  await (await inMemorySessions.agents.session(helper)).generate("saved");
  expect(await inMemorySessions.readUsage()).toMatchObject({
    recovered: 0,
    unreadable: 0,
  });
  const inMemoryLedger = await started({
    sessions: new UnlistedSessions(join(state, "unlisted")),
  });
  await (await inMemoryLedger.agents.session(helper)).generate("saved");
  expect(await inMemoryLedger.readUsage()).toMatchObject({
    recovered: 0,
    unreadable: 0,
  });
});

it("a running run continuing a session recovers an earlier engine's lost turn immediately without claiming it", async () => {
  const sessions = state;
  const helper = agent({ name: "helper", prompt: "Help." });
  const writer = await started({
    sessions: durableSessions(sessions),
    state,
    usageStore: await failingUsage((write) => write <= 2),
  });
  const direct = await writer.agents.session(helper);
  await direct.generate("fact and marker both fail");
  const { ref } = direct;
  await writer.dispose();

  catalog.reset();
  const wait = gated();
  step("continues").do(async ({ agents }) => {
    const session = await agents.session(helper, { session: ref });
    await session.generate("the run's own turn");
    wait.opened();
    await wait.gate;
    return "done";
  });
  const second = await started({
    sessions: durableSessions(sessions),
    state,
  });
  const launched = await second.launch<string>("continues", {});
  await wait.ready;
  const records = await second.readUsage();
  expect(records).toMatchObject({ recovered: 1, unreadable: 0, unsaved: 0 });
  const lost = records.facts.filter((fact) => fact.lost !== undefined);
  expect(lost).toHaveLength(1);
  expect(lost[0]).toMatchObject({
    agentId: UNATTRIBUTED,
    scope: "unattributed",
    sessionId: ref.id,
  });
  expect(lost[0]?.tokens?.total).toBeGreaterThan(0);
  const own = records.facts.filter((fact) => fact.sessionId === ref.id);
  expect(own).toHaveLength(2);
  expect(own.find((fact) => fact.lost === undefined)).toMatchObject({
    runId: launched.id,
    scope: "run",
  });
  wait.release();
  await expect(launched.result).resolves.toBe("done");
  expect(await second.readUsage()).toMatchObject({
    recovered: 1,
    unreadable: 0,
  });
});
