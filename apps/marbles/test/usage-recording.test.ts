import {
  chmod,
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  CreateMessageInput,
  CreateSessionInput,
  SessionMessage,
  SessionStore,
  UpdateMessageInput,
  UpdateSessionInput,
} from "@foundry/agents/session";
import { InMemorySessionStore } from "@foundry/agents/session";
import { ArtifactManager } from "@foundry/artifacts";
import { blobFiles, JsonArtifactStore } from "@foundry/artifacts/node";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { step } from "~/authoring/builder";
import { catalog } from "~/authoring/catalog";
import { agent } from "~/authoring/resources";
import type { Engine } from "~/lib/engine";
import { JsonSessionStore } from "~/lib/sessions/json-store";
import type { StateCollection } from "~/lib/state/store";
import { InMemoryStateStore, JsonStateStore } from "~/lib/state/store";
import type { SessionRef } from "~/lib/types";
import type { PriceLookup, TurnSource, UsageFact } from "~/lib/usage";
import { RECOVERED, UsageLedger, usageFact } from "~/lib/usage";
import type { ReconciledRun } from "~/lib/usage-evidence";
import {
  ledgerNames,
  transcriptTurn,
  UNATTRIBUTED,
  UsageEvidence,
} from "~/lib/usage-evidence";
import { costLabel, tokensLabel } from "~/views/usage-format";
import { registerSetupStep, SETUP_STEP } from "~/workspace/setup-step";
import { dashboardSnapshot } from "~/workspace/snapshot";
import { DEFAULT_DRAFT } from "~/workspace/templates";
import { totalOf, workspaceUsage } from "~/workspace/usage";
import { startEngine, testEngine } from "./helpers/engine";

const engines: Engine[] = [];
let state: string;

beforeEach(async () => {
  state = await mkdtemp(join(tmpdir(), "marbles-usage-"));
});

afterEach(async () => {
  await Promise.all(engines.splice(0).map((engine) => engine.dispose()));
  catalog.reset();
  await rm(state, { force: true, recursive: true });
});

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

  const { facts, unreadable } = engine.usage.read();
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
    // The mock reports tokens; its catalog rows have no list price.
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
    // Recorded on the first pass; a replay returns the same message.
    await reviewer.generate("one-turn call");
    // A session turn runs again on replay, so it is new consumption.
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
  await vi.waitFor(() => expect(engine.usage.read().facts).toHaveLength(2));
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
  const turns = engine.usage.read().facts;
  expect(turns).toHaveLength(3);
  // Both session turns ran in the same replayed session.
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

  const { facts } = engine.usage.read();
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
  // Two turns on the opened session, one on the one-turn call's own session.
  expect(
    facts.filter((fact) => fact.sessionId === session.ref.id)
  ).toHaveLength(2);
  const { byRun, usage } = workspaceUsage(engine.usage.read(), "test");
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
  // 600k uncached input at $3, 400k cached at $0.30, 100k output at $15;
  // reasoning is part of output and is not billed again.
  expect(fact.cost).toEqual({
    amount: 1.8 + 0.12 + 1.5,
    currency: "USD",
    kind: "estimated",
    pricing: { rates, reference: "@foundry/models anthropic/sonnet" },
  });
  expect(fact).toMatchObject({
    completedAt: 2000,
    durationMs: 1500,
    harness: "claude-code",
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

it("JSON facts survive a restart, record each turn once, and count what cannot be read", async () => {
  const fact: UsageFact = usageFact(
    { message: message("m3"), route: {}, source, workspaceId: "ws" },
    () => undefined
  );
  const first = new UsageLedger(new JsonStateStore(state));
  first.record(fact);
  first.record(fact);
  first.record({ ...fact, turnId: "m4" });

  const reopened = new UsageLedger(new JsonStateStore(state));
  expect(
    reopened
      .read()
      .facts.map((item) => item.turnId)
      .sort()
  ).toEqual(["m3", "m4"]);

  await writeFile(join(state, "usage", "broken.json"), "{not json");
  const after = new UsageLedger(new JsonStateStore(state)).read();
  expect(after.facts).toHaveLength(2);
  expect(after.unreadable).toBe(1);
});

const priced: PriceLookup = () => ({
  rates: { input: 3, output: 15 },
  reference: "@foundry/models anthropic/sonnet",
});

function stored(turnId: string, fact: Record<string, unknown>) {
  return JSON.stringify({ facts: { [turnId]: fact }, version: 1 });
}

it("after a restart, syntactically valid but malformed facts count as unreadable and never break totals", async () => {
  const good = usageFact(
    { message: message("good"), route: {}, source, workspaceId: "ws" },
    priced
  );
  new UsageLedger(new JsonStateStore(state)).record(good);
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
    await writeFile(
      join(state, "usage", `bad-${name}.json`),
      stored(`bad-${name}`, value)
    );
  }
  const reopened = new UsageLedger(new JsonStateStore(state)).read();
  expect(reopened.facts.map((fact) => fact.turnId)).toEqual(["good"]);
  expect(reopened.unreadable).toBe(Object.keys(malformed).length);
  const total = totalOf(reopened.facts);
  expect(() => costLabel(total)).not.toThrow();
  expect(costLabel(total)).toBe("$4.50 est.");
  expect(tokensLabel(total)).toContain("1 turn");
});

it("never overwrites a run document it cannot read; the new turn goes beside it", async () => {
  const first = usageFact(
    { message: message("first"), route: {}, source, workspaceId: "ws" },
    priced
  );
  new UsageLedger(new JsonStateStore(state)).record(first);
  const path = join(state, "usage", "run.run-1.json");
  await writeFile(path, '{"facts": oops');
  const next = usageFact(
    { message: message("next"), route: {}, source, workspaceId: "ws" },
    priced
  );
  const ledger = new UsageLedger(new JsonStateStore(state));
  expect(ledger.record(next)).toEqual({ saved: "fact" });
  expect(await readFile(path, "utf8")).toBe('{"facts": oops');
  const after = new UsageLedger(new JsonStateStore(state)).read();
  expect(after.facts.map((fact) => fact.turnId)).toEqual(["next"]);
  expect(after.unreadable).toBe(1);
});

it("a run read while it settles, before its file is written, is never counted as unreadable", async () => {
  // The setup run's feed post is published to the artifact store on disk
  // after the run settles and before its file is written.
  const built = testEngine({
    artifacts: new ArtifactManager({
      files: blobFiles(join(state, "artifacts", "blobs")),
      store: new JsonArtifactStore({
        path: join(state, "artifacts", "records.json"),
      }),
    }),
    print: () => undefined,
    sessions: new JsonSessionStore(join(state, "sessions")),
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
  // A host polls while the run ends: no read may land in the gap for good.
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

/** A JSON store whose usage writes fail when `fail` says so. */
class FailingStore extends JsonStateStore {
  writes = 0;
  readonly #fail: (write: number) => boolean;

  constructor(dir: string, fail: (write: number) => boolean) {
    super(dir);
    this.#fail = fail;
  }

  override write(
    collection: StateCollection,
    key: string,
    value: Readonly<Record<string, unknown>>
  ): void {
    if (collection === "usage") {
      this.writes += 1;
      if (this.#fail(this.writes)) {
        throw new Error("disk full");
      }
    }
    super.write(collection, key, value);
  }
}

it("a second turn whose usage cannot be saved leaves a marker, so the first turn's total says it is partial, after a restart too", async () => {
  const store = new FailingStore(state, (write) => write === 2);
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
    store,
  });
  const launched = await engine.launch<string>("two", {});
  // The run still completes.
  await expect(launched.result).resolves.toBe("done");
  const { facts, unsaved } = engine.usage.read();
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

  // A restart reads the marker back.
  const reopened = new UsageLedger(new JsonStateStore(state)).read();
  expect(totalOf(reopened.facts)).toMatchObject({ missing: 1, turns: 2 });
});

it("when the fact and its marker both fail, a new engine over the same disk finds the turn in the durable transcript, claims it for no run, and says the run's total may be incomplete", async () => {
  const sessions = join(state, "sessions");
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
    sessions: new JsonSessionStore(sessions),
    state,
    store: new FailingStore(state, (write) => write === 2 || write === 3),
  });
  const launched = await first.launch<string>("two", {});
  await expect(launched.result).resolves.toBe("done");
  // In this process: the in-memory marker, until the transcript accounts for it.
  expect(first.usage.read()).toMatchObject({ unsaved: 1 });
  await first.dispose();

  // Before reconciliation, the ledger alone would read as one complete turn.
  expect(
    totalOf(new UsageLedger(new JsonStateStore(state)).read().facts)
  ).toMatchObject({ missing: 0, turns: 1 });
  // Price the saved leaf, as a provider could have, to show the label plainly.
  const disk = new JsonStateStore(state);
  const key = `run.${encodeURIComponent(launched.id)}`;
  const document = disk.read("usage", key) as {
    facts: Record<string, Record<string, unknown>>;
  };
  for (const fact of Object.values(document.facts)) {
    fact.cost = {
      amount: 2,
      currency: "USD",
      kind: "reported",
      reference: "probe",
    };
  }
  disk.write("usage", key, document);

  // A new engine, as a new process builds it: nothing in memory from the first.
  catalog.reset();
  const second = await startEngine({
    print: () => undefined,
    sessions: new JsonSessionStore(sessions),
    state,
  });
  engines.push(second);
  const records = await second.readUsage();
  expect(records).toMatchObject({ recovered: 1, unreadable: 0, unsaved: 0 });
  const recovered = records.facts.find((fact) => fact.lost !== undefined);
  // The session was opened in the run, but that proves no later turn's run or step.
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
  // The workspace counts it, with its tokens, as not recorded.
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

/** A new engine over `state`, as a new process builds it: nothing in memory from the writer. */
async function reader() {
  catalog.reset();
  const engine = await startEngine({
    print: () => undefined,
    sessions: new JsonSessionStore(join(state, "sessions")),
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
    sessions: new JsonSessionStore(join(state, "sessions")),
    state,
    store: new FailingStore(state, (write) => write >= 2),
  });
  engines.push(writer);
  const helper = agent({ name: "helper", prompt: "Help." });
  const session = await writer.agents.session(helper);
  await session.generate("one");
  await session.generate("two");
  // Immediately: no settling delay hides the committed turn.
  const second = await reader();
  const first = await second.readUsage();
  expect(first).toMatchObject({ recovered: 1, unreadable: 0 });
  const recovered = first.facts.find((fact) => fact.lost !== undefined);
  // Only direct facts name the session, but that proves no later turn direct.
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
  // Another committed turn after the reader cached the transcript.
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
  await sessions.createSession({ id: "s" });
  const evidence = new UsageEvidence({
    recordedOf: () => ({
      ledger: { "marbles:flow|agents.session|0": { id: "deleted" } },
    }),
    sessions: Object.assign(sessions, {
      // The first read fails, and later failures can occur without a stamp.
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
  // A session is filed before a run's file names it: not listed is missing.
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
    sessions: new JsonSessionStore(join(state, "sessions")),
    state,
    store: new FailingStore(state, (write) => write === 2 || write === 3),
  });
  const launched = await writer.launch<string>("two", {});
  await expect(launched.result).resolves.toBe("done");
  await writer.dispose();
  const disk = new JsonStateStore(state);
  const key = `run.${encodeURIComponent(launched.id)}`;
  const document = disk.read("usage", key) as {
    facts: Record<string, Record<string, unknown>>;
  };
  for (const fact of Object.values(document.facts)) {
    fact.cost = {
      amount: 2,
      currency: "USD",
      kind: "reported",
      reference: "probe",
    };
  }
  disk.write("usage", key, document);
  await writeFile(join(state, "sessions", `${sessionId}.json`), "{broken");

  const second = await reader();
  const records = await second.readUsage();
  expect(records).toMatchObject({ recovered: 0, unreadable: 1 });
  // The run named the session, but that does not make the lost turns its.
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

  // A missing transcript cannot be verified either, and is no one's.
  await rm(join(state, "sessions", `${sessionId}.json`));
  const third = await reader();
  expect((await third.readUsage()).unreadableAt).toEqual({
    direct: 0,
    runs: new Map(),
    unowned: 1,
  });
  // A settled run's own file that cannot be read is that run's.
  const evidence = new UsageEvidence({
    recordedOf: () => "unreadable",
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
    sessions: new JsonSessionStore(join(state, "sessions")),
    state,
    store: new FailingStore(state, (write) => write === 2 || write === 3),
  });
  const helper = agent({ name: "helper", prompt: "Help." });
  const kept = await writer.agents.session(helper);
  await kept.generate("saved one");
  const orphan = await writer.agents.session(helper);
  await orphan.generate("fact and marker both fail");
  await kept.generate("saved two");
  await writer.dispose();
  // Nothing durable in the usage ledger names the orphan session.
  const ledger = new UsageLedger(new JsonStateStore(state)).read();
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
  // Not claimed as direct: outside runs keeps its two saved turns, and says one more may be its.
  expect(usage.outsideRuns).toMatchObject({ turns: 2, unattributed: 1 });
  expect(costLabel(usage.outsideRuns)).toContain(
    "may be incomplete: 1 unattributed turn"
  );
  // Another workspace's state holds other sessions; this one never reads them.
  const elsewhere = await mkdtemp(join(tmpdir(), "marbles-usage-other-"));
  try {
    catalog.reset();
    const other = await startEngine({
      print: () => undefined,
      sessions: new JsonSessionStore(join(elsewhere, "sessions")),
      state: elsewhere,
    });
    engines.push(other);
    expect((await other.readUsage()).facts).toEqual([]);
  } finally {
    await rm(elsewhere, { force: true, recursive: true });
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
    sessions: new JsonSessionStore(join(state, "sessions")),
    state,
    store: new FailingStore(state, (write) => write === 2 || write === 3),
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
  // The run may hold it, so it says so; it is not counted as the run's.
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
  // Writes 2 and 4 are the facts that fail; their markers (3 and 5) save.
  const writer = await startEngine({
    print: () => undefined,
    sessions: new JsonSessionStore(join(state, "sessions")),
    state,
    store: new FailingStore(state, (write) => write === 2 || write === 4),
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
  // A step named `a.b` is not `a`'s child `b`; a record kept before its path proves the run, no step.
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
  // Finished a second ago unless told otherwise: before any reader below was made.
  const turn = (sessionId: string, completedAt = Date.now() - 1000) =>
    sessions.appendMessage({
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
  await sessions.createSession({ id: "run-session", title: "run" });
  await sessions.createSession({
    id: "opened",
    parentSessionId: "run-session",
  });
  await sessions.createSession({
    id: "one-turn",
    parentSessionId: "run-session",
  });
  // Opened before the run, outside any: the run only continued it.
  await sessions.createSession({ id: "continued" });
  // A delegated child's: its parent's turn reports none of it.
  await sessions.createSession({
    id: "child",
    parentSessionId: "opened",
    recursionDepth: 1,
  });
  await sessions.appendMessage({
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
  // Listed, as the JSON store lists them: the child is named by nothing else.
  const stamps = () =>
    ["run-session", "opened", "one-turn", "continued", "child"].map((id) => ({
      id,
      stamp: null,
    }));
  const evidence = new UsageEvidence({
    recordedOf: () => recorded,
    sessions,
    stamps,
  });
  // Another agent continued the one-turn session later: its saved turn proves nothing of the call's.
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
  // Filed under the run's session, named by its file, inside its window: still no proof of this turn.
  expect(bySession.get("opened")).toMatchObject({ scope: "unattributed" });
  expect(bySession.get("continued")).toMatchObject({ scope: "unattributed" });
  expect(bySession.get("child")).toMatchObject({ scope: "unattributed" });
  expect(facts).toHaveLength(5);
  // Even a newest turn committed after the reader started must be visible.
  // An active run naming its session is not proof that it will record it.
  const running = new UsageEvidence({
    recordedOf: () => recorded,
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
  // A running run's file proves nothing yet: not even its one-turn call.
  expect(live.facts.every((fact) => fact.scope === "unattributed")).toBe(true);
});

/** Gates a step until the test lets it finish, and says when it is waiting. */
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
    sessions: new JsonSessionStore(join(state, "sessions")),
    state,
    store: new FailingStore(state, () => true),
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
  // Write 1 is the run's fact; every later fact and marker fails.
  const writer = await startEngine({
    print: () => undefined,
    sessions: new JsonSessionStore(join(state, "sessions")),
    state,
    store: new FailingStore(state, (write) => write >= 2),
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
  const sessions = new JsonSessionStore(join(state, "sessions"));
  const store = new FailingStore(state, () => failing);
  const first = await startEngine({
    print: () => undefined,
    sessions,
    state,
    store,
  });
  const creating = await first.launch<string>("creator", {});
  await wait.ready;
  // A second engine over the same disk: the consumer overlaps the creator.
  const other = await startEngine({
    print: () => undefined,
    sessions,
    state,
    store,
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
  // The creator keeps only its saved turn; both turns that finished while it ran may be its.
  expect(usageOf(creating.id)).toMatchObject({ turns: 1, unattributed: 2 });
  // The consumer's own turn is not lost from it: it may be the consumer's.
  expect(usageOf(consuming.id)).toMatchObject({ turns: 0, unattributed: 1 });
  expect(costLabel(usageOf(consuming.id))).toBe(
    "unknown · 1 unattributed turn may belong here"
  );
  // The consumer run's window clears it of the creator's earlier turn, but
  // not its workflow: another run of it may have taken that turn.
  const workflow = snapshot.usage?.byWorkflow.find(
    (group) => group.id === "consumer"
  );
  expect(costLabel(workflow?.total)).toBe(
    "unknown · 2 unattributed turns may belong here"
  );
});

it("a direct session a workflow continues in another engine, whose fact and marker both fail with EACCES, is not claimed as direct by a fresh reader, and the workflow says the turn may be its, even once the transcript cannot be read", async () => {
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
  const sessions = new JsonSessionStore(join(state, "sessions"));
  const host = await started({ sessions, state });
  const direct = await host.agents.session(helper);
  await direct.generate("saved direct turn");
  ({ ref } = direct);
  const usageDir = join(state, "usage");
  const transcript = join(state, "sessions", `${direct.ref.id}.json`);
  const { mode } = await stat(transcript);
  const fresh = async () => {
    catalog.reset();
    consumer();
    return await started({
      sessions: new JsonSessionStore(join(state, "sessions")),
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
    // A real permission failure: both the fact and its marker cannot be written.
    await chmod(usageDir, 0o500);
    const workflowEngine = await started({ sessions, state });
    const consuming = await workflowEngine.launch<string>("consumer", {});
    await wait.ready;
    const messages = await sessions.listMessages(direct.ref.id);
    const turns = messages.filter(
      (item) => item.role === "assistant" && item.metadata?.usage
    );
    expect(turns).toHaveLength(2);
    // Neither the workflow turn's fact nor its marker reached the disk.
    expect(await readdir(usageDir)).toEqual([
      `direct.${encodeURIComponent(direct.ref.id)}.json`,
    ]);
    const [savedTurn, lostTurn] = turns;
    const tokensOf = (turn: SessionMessage | undefined) =>
      turn?.metadata?.usage?.totalTokens ?? 0;

    // A reader that cannot load the running run: nothing proves the turn direct.
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
    // Workspace compute keeps both turns' tokens.
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
    // The known workflow has no loaded run, yet it is not shown as empty.
    expect(labelOf(snapshot, "consumer")).toBe(
      "unknown · 1 unattributed turn may belong here"
    );

    // The transcript cannot be read: its lost turn's tokens are gone, but
    // only direct facts naming the session does not make the loss theirs.
    await chmod(transcript, 0o000);
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
    await chmod(transcript, mode);

    await chmod(usageDir, 0o700);
    wait.release();
    await expect(consuming.result).resolves.toBe("consumed");
    await workflowEngine.dispose();

    // Settled: the run is loaded, and says the turn may be its, not that it is.
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
    await chmod(transcript, mode);
    await chmod(usageDir, 0o700);
    wait.release();
  }
});

it("a session one settled run names, which a workflow in another engine continues with its fact and marker both failing with EACCES, warns that workflow, not only the run, when the transcript cannot be read", async () => {
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
  const sessions = new JsonSessionStore(join(state, "sessions"));
  const host = await started({ sessions, state });
  const producing = await host.launch<string>("producer", {});
  await expect(producing.result).resolves.toBe("produced");
  if (!ref) {
    throw new Error("the producer opened no session");
  }
  const usageDir = join(state, "usage");
  const transcript = join(state, "sessions", `${ref.id}.json`);
  const { mode } = await stat(transcript);
  const fresh = async () => {
    catalog.reset();
    define();
    return await started({
      sessions: new JsonSessionStore(join(state, "sessions")),
      state,
    });
  };
  try {
    await chmod(usageDir, 0o500);
    const workflowEngine = await started({ sessions, state });
    const consuming = await workflowEngine.launch<string>("consumer", {});
    await wait.ready;
    expect(await readdir(usageDir)).toEqual([
      `run.${encodeURIComponent(producing.id)}.json`,
    ]);
    await chmod(transcript, 0o000);
    await expect(readFile(transcript)).rejects.toMatchObject({
      code: "EACCES",
    });

    const blind = await fresh();
    // Only the producer's settled run is loaded; it alone names the session.
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
    // The consumer's workflow, whose run this reader cannot load, is not empty.
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

    await chmod(transcript, mode);
    await chmod(usageDir, 0o700);
    wait.release();
    await expect(consuming.result).resolves.toBe("consumed");
  } finally {
    await chmod(transcript, mode);
    await chmod(usageDir, 0o700);
    wait.release();
  }
});

it("damaged usage documents stay with the owner their key names: a run's with that run, a direct session's outside runs, and an unrelated workflow stays empty", async () => {
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
    sessions: new JsonSessionStore(join(state, "sessions")),
    state,
  });
  const launched = await writer.launch<string>("priced", {});
  await expect(launched.result).resolves.toBe("done");
  const disk = new JsonStateStore(state);
  const key = `run.${encodeURIComponent(launched.id)}`;
  const document = disk.read("usage", key) as {
    facts: Record<string, Record<string, unknown>>;
  };
  const [saved] = Object.values(document.facts);
  document.facts.broken = { ...saved, cost: { amount: "bad" }, turnId: "x" };
  disk.write("usage", key, document);
  await writeFile(join(state, "usage", "direct.gone.json"), "{broken");

  catalog.reset();
  define();
  const second = await started({
    sessions: new JsonSessionStore(join(state, "sessions")),
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
  const sessionsDir = join(state, "sessions");
  const writer = await startEngine({
    print: () => undefined,
    sessions: new JsonSessionStore(sessionsDir),
    state,
    store: new FailingStore(state, (write) => write === 2 || write === 3),
  });
  const helper = agent({ name: "helper", prompt: "Help." });
  const kept = await writer.agents.session(helper);
  await kept.generate("saved");
  const orphan = await writer.agents.session(helper);
  await orphan.generate("fact and marker both fail");
  await writer.dispose();

  const second = await reader();
  const before = await second.readUsage();
  expect(before).toMatchObject({ recovered: 1, unreadable: 0 });
  // A self-referencing link: statting it fails with ELOOP, not ENOENT.
  await symlink("broken-loop.json", join(sessionsDir, "broken-loop.json"));
  expect(
    new JsonSessionStore(sessionsDir)
      .stamps()
      .find((entry) => entry.id === "broken-loop")
  ).toEqual({ id: "broken-loop", stamp: null });
  const cached = await second.readUsage();
  const fresh = await (await reader()).readUsage();
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

/** A disk session store whose directory cannot be listed, though its files can be read. */
class UnlistableSessions extends JsonSessionStore {
  override stamps(): never {
    throw new Error("EACCES: permission denied, scandir");
  }
}

it("a listing that fails on a new reader's first read still reads the named sessions, and every total, even an empty workflow's, says it may be incomplete", async () => {
  const helper = agent({ name: "helper", prompt: "Help." });
  step("idle").do(() => "no compute");
  const writer = await startEngine({
    print: () => undefined,
    sessions: new JsonSessionStore(join(state, "sessions")),
    state,
    store: new FailingStore(state, (write) => write === 2 || write === 3),
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
    sessions: new UnlistableSessions(join(state, "sessions")),
    state,
  });
  engines.push(second);
  const records = await second.readUsage();
  // The session a saved fact names is still read; nothing else can be ruled out.
  expect(records).toMatchObject({ recovered: 1, unreadable: 1 });
  expect(records.unreadableAt.unowned).toBe(1);
  const snapshot = snapshotOf(second, records, await second.runs());
  expect(snapshot.usage?.total).toMatchObject({ turns: 2, unreadable: 1 });
  // The recovered turn has no per-turn proof, so it is not claimed as direct.
  expect(snapshot.usage?.outsideRuns).toMatchObject({
    turns: 1,
    unattributed: 1,
    unreadable: 1,
  });
  // It finished before the idle run started, so only the unreadable record may be the run's.
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

it("labels a priced total with a lost turn as partial, never as whole", () => {
  const ledger = new UsageLedger(new InMemoryStateStore());
  const saved = usageFact(
    { message: message("saved"), route: {}, source, workspaceId: "ws" },
    priced
  );
  ledger.record(saved);
  const lostTurn = usageFact(
    { message: message("lost"), route: {}, source, workspaceId: "ws" },
    priced
  );
  const failing = new UsageLedger({
    append: () => undefined,
    list: () => [],
    lock: () => ({ holder: "test" }),
    log: () => [],
    read: () => undefined,
    remove: () => undefined,
    revision: () => "0",
    write: () => {
      throw new Error("read-only");
    },
  });
  expect(failing.record(lostTurn)).toMatchObject({ saved: "nothing" });
  const total = totalOf([saved, ...failing.read().facts]);
  expect(costLabel(total)).toBe(
    "$4.50 est. · partial: 1 of 2 turns not recorded"
  );
});

it("a settled run's file that could not be read is read again, so a repair counts on the next read of the same engine", async () => {
  step("settles").do(() => "done");
  const writer = await started({
    sessions: new JsonSessionStore(join(state, "sessions")),
    state,
  });
  const launched = await writer.launch<string>("settles", {});
  await expect(launched.result).resolves.toBe("done");
  await writer.dispose();

  const second = await reader();
  const file = join(state, "runs", `${launched.id}.json`);
  const original = await readFile(file, "utf8");
  await writeFile(file, "{ not json");
  const damaged = await second.readUsage();
  expect(damaged.unreadableAt.runs.get(launched.id)).toBe(1);
  await writeFile(file, original);
  const repaired = await second.readUsage();
  expect(repaired).toMatchObject({ unreadable: 0 });
  expect(repaired.unreadableAt.runs.has(launched.id)).toBe(false);
});

/**
 * Sessions kept on disk behind a store that cannot list them, as a host
 * wrapping its own store hands the engine.
 */
class UnlistedSessions implements SessionStore {
  readonly #inner: JsonSessionStore;

  constructor(dir: string) {
    this.#inner = new JsonSessionStore(dir);
  }

  appendMessage(input: CreateMessageInput) {
    return this.#inner.appendMessage(input);
  }

  createSession(input?: CreateSessionInput) {
    return this.#inner.createSession(input);
  }

  getSession(id: string) {
    return this.#inner.getSession(id);
  }

  listMessages(sessionId: string) {
    return this.#inner.listMessages(sessionId);
  }

  updateMessage(id: string, patch: UpdateMessageInput) {
    return this.#inner.updateMessage(id, patch);
  }

  updateSession(id: string, patch: UpdateSessionInput) {
    return this.#inner.updateSession(id, patch);
  }
}

it("a store that cannot list sessions and outlives the process says every total may be incomplete, since a session only a lost marker named is never found", async () => {
  const sessions = join(state, "sessions");
  const helper = agent({ name: "helper", prompt: "Help." });
  // Writes 1 and 2: the only turn's fact and its marker.
  const writer = await started({
    sessions: new UnlistedSessions(sessions),
    state,
    store: new FailingStore(state, (write) => write <= 2),
  });
  const orphan = await writer.agents.session(helper);
  await orphan.generate("fact and marker both fail");
  // In this process the marker held in memory still names the session.
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
  // Nothing durable names the session, so its turn is not found: the totals say so.
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
  const sessions = join(state, "sessions");
  const helper = agent({ name: "helper", prompt: "Help." });
  // Writes 1 and 2: the direct turn's fact and its marker.
  const writer = await started({
    sessions: new JsonSessionStore(sessions),
    state,
    store: new FailingStore(state, (write) => write <= 2),
  });
  const direct = await writer.agents.session(helper);
  await direct.generate("fact and marker both fail");
  const { ref } = direct;
  await writer.dispose();

  // A new engine, as a new process builds it, with a run that continues the session.
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
    sessions: new JsonSessionStore(sessions),
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
  // The run's own turn is its saved fact, counted once.
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
