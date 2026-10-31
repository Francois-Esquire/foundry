import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, it } from "vitest";
import { step, workflow } from "~/authoring/builder";
import { catalog } from "~/authoring/catalog";
import { agent } from "~/authoring/resources";
import { Diagnostics, hostOutput } from "~/dashboard/diagnostics";
import { dashboardSnapshot } from "~/dashboard/snapshot";
import { stepUsage, totalOf, workspaceUsage } from "~/dashboard/usage";
import type { Engine } from "~/lib/engine";
import { JsonSessionStore } from "~/lib/sessions/json-store";
import { JsonStateStore } from "~/lib/state/store";
import type { DirectUsageFact, RunUsageFact, UsageCost } from "~/lib/usage";
import { filterLogs, operatingLogs } from "~/views/operating-model";
import { costCell, costLabel, tokensLabel } from "~/views/usage-format";
import { startEngine } from "./helpers/engine";

const engines: Engine[] = [];

afterEach(async () => {
  await Promise.all(engines.splice(0).map((engine) => engine.dispose()));
  catalog.reset();
});

const HERE = dirname(fileURLToPath(import.meta.url));
const LOCAL_SOURCE = /^dashboard-usage\.test\.ts:\d+$/;

function fact(
  turnId: string,
  path: readonly string[],
  cost: UsageCost,
  overrides: Partial<RunUsageFact> = {}
): RunUsageFact {
  return {
    agentId: "reviewer",
    completedAt: 1,
    cost,
    definitionId: path[0] ?? "root",
    path,
    runId: "run-1",
    scope: "run",
    sessionId: "s",
    tokens: { input: 100, output: 10, total: 110 },
    turnId,
    version: 1,
    workspaceId: "ws",
    ...overrides,
  };
}

function direct(
  turnId: string,
  cost: UsageCost,
  overrides: Partial<DirectUsageFact> = {}
): DirectUsageFact {
  return {
    agentId: "reviewer",
    completedAt: 1,
    cost,
    scope: "direct",
    sessionId: "direct-session",
    tokens: { input: 100, output: 10, total: 110 },
    turnId,
    version: 1,
    workspaceId: "ws",
    ...overrides,
  };
}

const estimate = (amount: number): UsageCost => ({
  amount,
  currency: "USD",
  kind: "estimated",
  pricing: { rates: { input: 1, output: 1 }, reference: "r" },
});
const unknown: UsageCost = { kind: "unknown", reason: "no list price" };

it("a step's inclusive total sums its descendants' facts, never their totals", () => {
  const facts = [
    fact("a", ["outer"], estimate(1)),
    fact("b", ["outer", "child"], estimate(2)),
    fact("c", ["outer", "child", "leaf"], estimate(4)),
    // A sibling whose name shares a prefix is not a descendant.
    fact("d", ["outer", "children"], estimate(8)),
  ];
  const child = stepUsage(facts, "outer.child");
  expect(child?.direct.estimated).toEqual([{ amount: 2, currency: "USD" }]);
  expect(child?.inclusive.estimated).toEqual([{ amount: 6, currency: "USD" }]);
  expect(child?.inclusive.turns).toBe(2);
  // The run's total is the facts once, not the root's inclusive plus each child's.
  expect(totalOf(facts).estimated).toEqual([{ amount: 15, currency: "USD" }]);
  expect(stepUsage(facts, "elsewhere")).toBeUndefined();
});

it("unknown prices are counted, not added as zero, and partial totals say so", () => {
  const partial = totalOf([
    fact("a", ["outer"], estimate(0.25)),
    fact("b", ["outer"], unknown),
  ]);
  expect(partial).toMatchObject({ turns: 2, unpriced: 1 });
  expect(costLabel(partial)).toBe(
    "$0.2500 est. · partial: 1 of 2 turns unpriced"
  );
  expect(costCell(partial)).toBe("~$0.2500+?");

  const allUnknown = totalOf([fact("a", ["outer"], unknown)]);
  expect(allUnknown.estimated).toEqual([]);
  expect(costLabel(allUnknown)).toBe("unknown · 1 turn unpriced");
  expect(costCell(allUnknown)).toBe("cost ?");

  expect(costLabel(totalOf([]))).toBe("no usage recorded");
  expect(costCell(undefined)).toBe("");
  expect(tokensLabel(totalOf([]))).toBe("no usage recorded");
});

it("keeps reported, estimated and currencies apart, and turns without tokens visible", () => {
  const total = totalOf([
    fact("a", ["outer"], {
      amount: 1.5,
      currency: "USD",
      kind: "reported",
      reference: "provider",
    }),
    fact("b", ["outer"], estimate(0.5)),
    fact(
      "c",
      ["outer"],
      {
        amount: 3,
        currency: "EUR",
        kind: "estimated",
        pricing: { rates: { input: 1, output: 1 }, reference: "r" },
      },
      { tokens: undefined }
    ),
  ]);
  expect(total.reported).toEqual([{ amount: 1.5, currency: "USD" }]);
  expect(total.estimated).toEqual([
    { amount: 3, currency: "EUR" },
    { amount: 0.5, currency: "USD" },
  ]);
  expect(costLabel(total)).toBe(
    "$1.50 reported + 3.00 EUR est. + $0.5000 est."
  );
  expect(tokensLabel(total)).toBe(
    "220 tokens (200 in · 20 out) · 3 turns · 1 without token counts"
  );
});

it("groups by workflow and agent, scoped to the workspace, and carries unreadable records", () => {
  const { byRun, usage } = workspaceUsage(
    {
      facts: [
        fact("a", ["build"], estimate(1)),
        fact("b", ["build"], estimate(1), {
          agentId: "writer",
          runId: "run-2",
        }),
        fact("c", ["review"], unknown, { runId: "run-3" }),
        fact("d", ["build"], estimate(5), { workspaceId: "other" }),
        direct("e", estimate(0.5), { agentId: "writer" }),
      ],
      recovered: 0,
      unreadable: 2,
      unreadableAt: { direct: 0, runs: new Map(), unowned: 2 },
      unsaved: 0,
      unsavedTurns: new Set(),
    },
    "ws"
  );
  expect([...byRun.keys()]).toEqual(["run-1", "run-2", "run-3"]);
  expect(usage.unreadable).toBe(2);
  // The direct turn counts in the workspace and its agent, not any workflow.
  expect(usage.total.estimated).toEqual([{ amount: 2.5, currency: "USD" }]);
  expect(usage.outsideRuns).toMatchObject({
    estimated: [{ amount: 0.5, currency: "USD" }],
    turns: 1,
  });
  expect(
    usage.byWorkflow.map((group) => [group.id, group.total.turns])
  ).toEqual([
    ["build", 2],
    ["review", 1],
  ]);
  expect(usage.byAgent.map((group) => [group.id, group.total.turns])).toEqual([
    ["reviewer", 2],
    ["writer", 2],
  ]);
});

it("projects recorded turns onto real runs and steps, and catalog origins onto the workspace", async () => {
  const reviewer = agent({ name: "reviewer", prompt: "Review." });
  const nested = step("nested").do(async ({ agents }) => {
    const session = await agents.session(reviewer);
    return (await session.generate("nested turn")).text;
  });
  step("outer").do(async ({ agents }) => {
    const session = await agents.session(reviewer);
    await session.generate("first");
    return await nested.run();
  });
  const engine = await startEngine({ print: () => undefined });
  engines.push(engine);
  const launched = await engine.launch("outer", {});
  await launched.result;
  const snapshot = dashboardSnapshot(await engine.runs(), {
    definitions: engine.definitions(),
    lastFinish: new Map(),
    monitors: engine.monitors(),
    root: HERE,
    schedules: engine.schedules(),
    startedAt: 0,
    status: "Ready",
    usage: engine.usage.read(),
    workspaceId: "test",
  });
  const run = snapshot.runs.find((item) => item.id === launched.id);
  expect(run?.usage?.turns).toBe(2);
  expect(run?.timing?.startedAt).toBeGreaterThanOrEqual(
    run?.timing?.createdAt ?? 0
  );
  expect(run?.timing?.endedAt).toBeDefined();
  const child = run?.steps
    .flatMap((item) => [item, ...item.children])
    .find((item) => item.id.startsWith("outer.") && item.usage);
  expect(child?.usage?.direct.turns).toBe(1);
  expect(snapshot.usage?.byWorkflow.map((group) => group.id)).toEqual([
    "outer",
  ]);
  expect(snapshot.usage?.byAgent.map((group) => group.id)).toEqual([
    "reviewer",
  ]);
  // Declared in this file, inside the workspace root: a local source.
  expect(
    snapshot.definitions.find((item) => item.id === "outer")?.origin
  ).toEqual({
    external: false,
    source: expect.stringMatching(LOCAL_SOURCE),
    workspaceId: "test",
  });
});

it("a step's log line shows once in Logs, attributed to its run and step, even when it looks like an engine line", async () => {
  const diagnostics = new Diagnostics();
  const statuses: string[] = [];
  const output = hostOutput(diagnostics, (line) => statuses.push(line));
  step("hear").do(({ log }) => {
    log("heard");
    log("[worker] hello");
    return 1;
  });
  const engine = await startEngine({ log: output.log, print: output.print });
  engines.push(engine);
  const launched = await engine.launch("hear", {});
  await launched.result;
  output.print("[schedule] hear → hear");
  const snapshot = dashboardSnapshot(await engine.runs(), {
    definitions: [],
    diagnostics: diagnostics.entries,
    lastFinish: new Map(),
    monitors: new Map(),
    root: HERE,
    schedules: [],
    startedAt: 0,
    status: "",
  });
  const lines = operatingLogs(snapshot);
  for (const message of ["heard", "[worker] hello"]) {
    expect(
      lines
        .filter((line) => line.message === message)
        .map((line) => [line.source, line.runId, line.stepId])
    ).toEqual([["run", launched.id, "hear"]]);
  }
  // The host-only filter shows Marbles' own lines and nothing a step logged.
  const host = filterLogs(lines, {
    level: "debug",
    query: "",
    source: "host",
  }).map((line) => line.message);
  expect(host).toEqual([
    "[step] hear started",
    "[step] hear complete",
    "[schedule] hear → hear",
  ]);
  // Body lines still reach the status line, as before.
  expect(statuses).toContain("[worker] hello");
});

it("a definition declared through a symlinked path is still local to the canonical workspace root", () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "marbles-origin-")));
  try {
    const root = join(dir, "project");
    const link = join(dir, "link");
    mkdirSync(join(root, ".foundry"), { recursive: true });
    writeFileSync(join(root, ".foundry", "flow.ts"), "");
    symlinkSync(root, link);
    const snapshot = dashboardSnapshot([], {
      definitions: [
        {
          input: { fields: [] },
          kind: "step",
          name: "flow",
          origin: `${join(link, ".foundry", "flow.ts")}:3`,
        },
        {
          input: { fields: [] },
          kind: "step",
          name: "packaged",
          origin: "/nowhere/prebuilt.js:9",
        },
      ],
      lastFinish: new Map(),
      monitors: new Map(),
      root,
      schedules: [],
      startedAt: 0,
      status: "",
      workspaceId: "ws",
    });
    expect(snapshot.definitions.map((item) => item.origin)).toEqual([
      {
        external: false,
        source: join(".foundry", "flow.ts:3"),
        workspaceId: "ws",
      },
      { external: true, source: "/nowhere/prebuilt.js:9", workspaceId: "ws" },
    ]);
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
});

it("after a restart, a malformed leaf in a run's document makes that run's, its steps' and its workflow's totals say they may be incomplete", async () => {
  const state = mkdtempSync(join(tmpdir(), "marbles-unreadable-"));
  try {
    const reviewer = agent({ name: "reviewer", prompt: "Review." });
    step("priced").do(async ({ agents }) => {
      const session = await agents.session(reviewer);
      await session.generate("one");
    });
    step("other").do(() => "no agents here");
    // Durable sessions beside durable state, as the host builds an engine.
    const durable = () => ({
      print: () => undefined,
      sessions: new JsonSessionStore(join(state, "sessions")),
      state,
    });
    const first = await startEngine(durable());
    const launched = await first.launch("priced", {});
    await launched.result;
    const quiet = await first.launch("other", {});
    await quiet.result;
    await first.dispose();
    // Price the saved leaf and add a malformed one beside it, on disk.
    const disk = new JsonStateStore(state);
    const key = `run.${encodeURIComponent(launched.id)}`;
    const document = disk.read("usage", key) as {
      facts: Record<string, Record<string, unknown>>;
    };
    const [saved] = Object.values(document.facts);
    if (!saved) {
      throw new Error("expected a saved fact");
    }
    saved.cost = {
      amount: 2,
      currency: "USD",
      kind: "reported",
      reference: "probe",
    };
    document.facts.broken = {
      ...saved,
      cost: { amount: "bad" },
      turnId: "broken",
    };
    disk.write("usage", key, document);

    catalog.reset();
    step("priced").do(() => undefined);
    step("other").do(() => undefined);
    const second = await startEngine(durable());
    engines.push(second);
    const records = await second.readUsage();
    expect(records.unreadable).toBe(1);
    expect(records.unreadableAt.runs.get(launched.id)).toBe(1);
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
    const warning =
      "$2.00 reported · may be incomplete: 1 unreadable usage record";
    expect(costLabel(run?.usage)).toBe(warning);
    expect(costCell(run?.usage)).toBe("$2.00+?");
    const stepUsed = run?.steps.find((item) => item.usage)?.usage;
    expect(costLabel(stepUsed?.direct)).toBe(warning);
    expect(costLabel(stepUsed?.inclusive)).toBe(warning);
    expect(
      costLabel(
        snapshot.usage?.byWorkflow.find((group) => group.id === "priced")?.total
      )
    ).toBe(warning);
    // The record was filed under one run: other runs and workflows are not implicated.
    const other = snapshot.runs.find((item) => item.id === quiet.id);
    expect(other?.usage).toBeUndefined();
    expect(snapshot.usage?.byWorkflow.map((group) => group.id)).toEqual([
      "priced",
    ]);
    // Any agent's total may hold it: the record's own agent is not trusted.
    expect(costLabel(snapshot.usage?.byAgent[0]?.total)).toBe(warning);
  } finally {
    rmSync(state, { force: true, recursive: true });
  }
});

it("a run whose only leaf is unreadable says so instead of 'no usage recorded', and unowned or direct records go where they may belong", () => {
  const records = (unreadableAt: {
    direct: number;
    runs: Map<string, number>;
    unowned: number;
  }) => ({
    facts: [fact("a", ["build"], estimate(1))],
    recovered: 0,
    unreadable:
      unreadableAt.direct +
      unreadableAt.unowned +
      [...unreadableAt.runs.values()].reduce((sum, count) => sum + count, 0),
    unreadableAt,
    unsaved: 0,
    unsavedTurns: new Set<string>(),
  });
  const owned = workspaceUsage(
    records({ direct: 0, runs: new Map([["run-9", 1]]), unowned: 0 }),
    "ws",
    { runs: new Map([["run-9", { createdAt: 0, definition: "review" }]]) }
  );
  expect(owned.mayBelongTo("run-9").unreadable).toBe(1);
  expect(owned.mayBelongTo("run-1").unreadable).toBe(0);
  expect(costLabel(totalOf([], owned.mayBelongTo("run-9").unreadable))).toBe(
    "unknown · 1 unreadable usage record may belong here"
  );
  expect(
    costLabel(
      owned.usage.byWorkflow.find((group) => group.id === "review")?.total
    )
  ).toBe("unknown · 1 unreadable usage record may belong here");
  expect(costLabel(owned.usage.outsideRuns)).toBe("no usage recorded");

  const unowned = workspaceUsage(
    records({ direct: 0, runs: new Map(), unowned: 1 }),
    "ws"
  );
  expect(unowned.mayBelongTo("run-1").unreadable).toBe(1);
  expect(costLabel(unowned.usage.byWorkflow[0]?.total)).toContain(
    "may be incomplete: 1 unreadable usage record"
  );
  expect(costLabel(unowned.usage.outsideRuns)).toContain("1 unreadable");

  const directOwned = workspaceUsage(
    records({ direct: 1, runs: new Map(), unowned: 0 }),
    "ws"
  );
  expect(directOwned.mayBelongTo("run-1").unreadable).toBe(0);
  expect(costLabel(directOwned.usage.outsideRuns)).toBe(
    "unknown · 1 unreadable usage record may belong here"
  );
  expect(costLabel(directOwned.usage.byWorkflow[0]?.total)).toBe("$1.00 est.");
});

it("a known workflow with no valid facts still says unowned unreadable records may belong to it, instead of 'no usage recorded'", () => {
  const { usage } = workspaceUsage(
    {
      facts: [],
      recovered: 0,
      unreadable: 1,
      unreadableAt: { direct: 0, runs: new Map(), unowned: 1 },
      unsaved: 0,
      unsavedTurns: new Set(),
    },
    "ws",
    {
      runs: new Map([["run-1", { createdAt: 0, definition: "healthy" }]]),
      workflows: ["healthy", "never-run"],
    }
  );
  const label = (id: string) =>
    costLabel(usage.byWorkflow.find((group) => group.id === id)?.total);
  expect(label("healthy")).toBe(
    "unknown · 1 unreadable usage record may belong here"
  );
  expect(label("never-run")).toBe(
    "unknown · 1 unreadable usage record may belong here"
  );
  // With nothing that may belong anywhere, an empty workflow has no total.
  const { usage: clean } = workspaceUsage(
    {
      facts: [],
      recovered: 0,
      unreadable: 0,
      unreadableAt: { direct: 0, runs: new Map(), unowned: 0 },
      unsaved: 0,
      unsavedTurns: new Set(),
    },
    "ws",
    { workflows: ["healthy"] }
  );
  expect(clean.byWorkflow).toEqual([]);
});

it("an unattributed turn counts in the workspace and its agent's totals, and is noted on outside runs, other agents, every workflow, and only the runs running when it finished", () => {
  const orphan = {
    ...direct("orphan", { kind: "unknown", reason: "recovered" }),
    agentId: "(unattributed)",
    completedAt: 150,
    lost: "recovered",
    scope: "unattributed" as const,
  };
  const { mayBelongTo, usage } = workspaceUsage(
    {
      facts: [
        fact("a", ["early"], estimate(1), { runId: "early-run" }),
        fact("b", ["during"], estimate(1), { runId: "during-run" }),
        orphan,
      ],
      recovered: 1,
      unreadable: 0,
      unreadableAt: { direct: 0, runs: new Map(), unowned: 0 },
      unsaved: 0,
      unsavedTurns: new Set(),
    },
    "ws",
    {
      runs: new Map([
        ["early-run", { createdAt: 0, definition: "early", endedAt: 100 }],
        ["during-run", { createdAt: 120, definition: "during", endedAt: 200 }],
      ]),
    }
  );
  expect(usage.total).toMatchObject({ missing: 1, turns: 3, unattributed: 0 });
  expect(usage.unattributed).toBe(1);
  expect(mayBelongTo("early-run").unattributed).toBe(0);
  expect(mayBelongTo("during-run").unattributed).toBe(1);
  const workflowTotal = (id: string) =>
    usage.byWorkflow.find((group) => group.id === id)?.total;
  // Its run ended before the turn, but another run of it, one this reader
  // cannot load, may have taken it.
  expect(costLabel(workflowTotal("early"))).toBe(
    "$1.00 est. · may be incomplete: 1 unattributed turn"
  );
  expect(costLabel(workflowTotal("during"))).toBe(
    "$1.00 est. · may be incomplete: 1 unattributed turn"
  );
  expect(costLabel(usage.outsideRuns)).toBe(
    "unknown · 1 unattributed turn may belong here"
  );
  const agentTotal = (id: string) =>
    usage.byAgent.find((group) => group.id === id)?.total;
  expect(agentTotal("reviewer")).toMatchObject({ turns: 2, unattributed: 1 });
  expect(agentTotal("(unattributed)")).toMatchObject({
    turns: 1,
    unattributed: 0,
  });
  expect(costCell(workflowTotal("during"))).toBe("~$1.00+?");
});

it("a workflow's setup lines stay in Logs with their run and no step; body lines appear once with their step; neither is Marbles' own", async () => {
  const diagnostics = new Diagnostics();
  const statuses: string[] = [];
  const output = hostOutput(diagnostics, (line) => statuses.push(line));
  const body = step("body").do(({ log }) => {
    log("plain body");
    log("[worker] body");
    return 1;
  });
  workflow("flow").do(({ log }) => {
    log("plain setup");
    log("[worker] setup");
    return body({});
  });
  const engine = await startEngine({ log: output.log, print: output.print });
  engines.push(engine);
  const launched = await engine.launch("flow", {});
  await launched.result;
  const snapshot = dashboardSnapshot(await engine.runs(), {
    definitions: [],
    diagnostics: diagnostics.entries,
    lastFinish: new Map(),
    monitors: new Map(),
    root: HERE,
    schedules: [],
    setupLogs: diagnostics.setupEntries,
    startedAt: 0,
    status: "",
  });
  const lines = operatingLogs(snapshot);
  const one = (message: string) => {
    const found = lines.filter((line) => line.message === message);
    expect(found).toHaveLength(1);
    return found[0];
  };
  for (const message of ["plain setup", "[worker] setup"]) {
    expect(one(message)).toMatchObject({
      runId: launched.id,
      runName: "flow",
      setup: true,
      source: "run",
    });
    expect(one(message)?.stepId).toBeUndefined();
  }
  for (const message of ["plain body", "[worker] body"]) {
    const line = one(message);
    expect(line).toMatchObject({ runId: launched.id, source: "run" });
    expect(line?.setup).toBeUndefined();
    expect(line?.stepId).toBeDefined();
  }
  const host = filterLogs(lines, { level: "debug", query: "", source: "host" });
  expect(host.some((line) => line.message.includes("setup"))).toBe(false);
  expect(host.some((line) => line.message.includes("body"))).toBe(false);
  expect(host.length).toBeGreaterThan(0);
  expect(statuses).toEqual(
    expect.arrayContaining(["plain setup", "[worker] setup", "[worker] body"])
  );
});
