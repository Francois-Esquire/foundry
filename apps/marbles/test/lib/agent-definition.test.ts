/**
 * An agent declared with a function: the function returns the definition
 * as each session opens, given the route that session must keep. It runs
 * on no import and no `extend`, once per session, never on a replayed
 * turn, and what it chose (route, skills, MCP servers) is what the session
 * opens with. Usage comes from a provider defined with the usage kit, so
 * snapshots are built by `@foundry/usage` itself and nothing is asked of a
 * real login.
 */

import { fileURLToPath } from "node:url";
import { McpClient } from "@foundry/agents/mcp";
import { defineSkill } from "@foundry/agents/skills";
import { usage } from "@foundry/usage";
import { defineProvider, window } from "@foundry/usage/provider";
import { Output } from "ai";
import { afterEach, describe, expect, expectTypeOf, it, vi } from "vitest";
import { z } from "zod";
import { step } from "~/authoring/builder";
import { catalog } from "~/authoring/catalog";
import { agent, skills } from "~/authoring/resources";
import { dispose, setHost } from "~/authoring/runtime";
import type { ManagerArgs } from "~/lib/bindings";
import type { Engine } from "~/lib/engine";
import { CLAUDE_CODE, CODEX } from "~/lib/harnesses";
import type { AgentsDeps } from "~/lib/managers/agents";
import { AgentsManager, buildDefinition } from "~/lib/managers/agents";
import { mockModels } from "~/lib/models/echo";
import { RunScope } from "~/lib/run-scope";
import type {
  AgentLike,
  AgentMcpServer,
  AgentRoute,
  DeferredAgent,
} from "~/lib/types";
import { BackgroundRuns } from "~/workspace/background-runs";
import { dispatchSchema } from "~/workspace/dispatch";
import { testEngine } from "../helpers/engine";

const HOUR = 3_600_000;
const NO_PROMPT = /has no prompt/;
const NOT_CONNECTED = /MCP server "missing" did not connect/;
const ROUTE_CONFLICT =
  /returned provider "claude-code" for a session on provider "codex"/;
const NO_NAME = /cannot name it/;
const SANDBOX_MCP = /sandbox session cannot reach/;
const ANOTHER_FUNCTION = /already declared by another function/;
const NOT_JSON = /extend's input must be JSON/;
const ANOTHER_INPUT = /was opened with another input/;

/** How much of the fixture Claude login's week is used; tests move it. */
let claudeWeekUsed = 40;
const readLimits = vi.fn(() =>
  Promise.resolve({
    identity: { id: "fixture", plan: "max" },
    limits: [
      window.hourly({ hours: 5, usedPercent: 10 }),
      window.weekly({
        resetsAt: new Date(Date.now() + 24 * HOUR),
        usedPercent: claudeWeekUsed,
      }),
    ],
  })
);
const claudeLogin = defineProvider({
  credential: () => ({}),
  id: "claude-fixture",
  limits: readLimits,
});
usage.add(claudeLogin({ name: "anthropic" }));

const claudeChecklist = defineSkill({
  manifest:
    "---\nname: claude-checklist\ndescription: Review with the Claude checklist\n---\nUse the Claude checklist.",
});
const codexChecklist = defineSkill({
  manifest:
    "---\nname: codex-checklist\ndescription: Review with the Codex checklist\n---\nUse the Codex checklist.",
});

const fixtureServer: AgentMcpServer = {
  id: "fixture",
  transport: {
    args: [fileURLToPath(new URL("../helpers/mcp-server.ts", import.meta.url))],
    command: process.execPath,
    kind: "stdio",
  },
};

/** Claude while its week has room, Codex once it is used up. */
async function routeFromUsage(): Promise<string> {
  const claude = await usage.query("anthropic");
  return claude.weekly?.exhausted ? "codex" : "claude-code";
}

/**
 * The agent the docs show: a route from usage unless the session already
 * has one, and the skills and MCP servers for that route.
 */
function usageRoutedReviewer(seen: AgentRoute[] = []) {
  return agent(async (route) => {
    seen.push(route);
    const provider = route.provider ?? (await routeFromUsage());
    const onCodex = provider === "codex";
    return {
      ...(onCodex ? {} : { mcp: [fixtureServer] }),
      prompt: "Review the change.",
      provider,
      skills: skills.none().add(onCodex ? codexChecklist : claudeChecklist),
    };
  });
}

const engines: Engine[] = [];

afterEach(async () => {
  await Promise.all(engines.splice(0).map((engine) => engine.dispose()));
  await dispose();
  catalog.reset();
  claudeWeekUsed = 40;
  readLimits.mockClear();
});

/** A host engine whose models answer `provider|tools|prompt`. */
function hostEngine(): Engine {
  const engine = testEngine({
    print: () => undefined,
    reply: ({ executor, prompt, tools }) =>
      `${executor.provider}|${tools.join(",")}|${prompt}`,
  });
  engines.push(engine);
  setHost(engine);
  return engine;
}

function parse(text: string) {
  const [provider = "", tools = "", ...prompt] = text.split("|");
  return {
    prompt: prompt.join("|"),
    provider,
    tools: tools ? tools.split(",") : [],
  };
}

function args(): ManagerArgs {
  const scope = new RunScope(`run-${Math.random()}`, "/tmp/project");
  return { frame: scope.frame(["root", "review"]), scope, write: () => 0 };
}

/** A bare agents manager over mock models, for sessions in a frame. */
function managerDeps(): AgentsDeps {
  const host = testEngine();
  engines.push(host);
  return {
    activities: host.activities,
    automations: host.automations,
    containerOf: (): never => {
      throw new Error("no sandbox in these tests");
    },
    defaultExecutor: () => CLAUDE_CODE,
    dry: false,
    interactions: host.interactions,
    models: mockModels([CLAUDE_CODE, CODEX], ({ executor }) =>
      String(executor.provider)
    ),
    root: process.cwd(),
    sessions: host.sessions,
    skills: () => Promise.resolve([]),
    warn: () => undefined,
  };
}

const verdict = Output.object({
  schema: z.object({ approved: z.boolean() }),
});

/** Named by its `const`, not by a digest of its source. */
const topLevelReviewer = agent(() => ({ prompt: "Review." }));

describe("when the function runs", () => {
  it("runs on no declaration and no extend, then once per session", async () => {
    hostEngine();
    const define = vi.fn(() => ({ prompt: "Review." }));
    const reviewer = agent(define);
    const onCodex = reviewer.extend({ provider: "codex" });
    expect(define).not.toHaveBeenCalled();
    expect(readLimits).not.toHaveBeenCalled();

    await reviewer.generate("Look.");
    await onCodex.generate("Look.");
    expect(define).toHaveBeenCalledTimes(2);

    const session = await setHostSession(reviewer);
    await session.generate("One.");
    await session.generate("Two.");
    expect(define).toHaveBeenCalledTimes(3);
  });

  it("reads usage when a session opens, so each session routes on what is left", async () => {
    hostEngine();
    const reviewer = usageRoutedReviewer();
    expect(parse((await reviewer.generate("Look.")).text).provider).toBe(
      "claude-code"
    );
    claudeWeekUsed = 100;
    expect(parse((await reviewer.generate("Look.")).text).provider).toBe(
      "codex"
    );
    expect(readLimits).toHaveBeenCalledTimes(2);
  });

  it("reads the usage snapshot @foundry/usage builds", async () => {
    claudeWeekUsed = 100;
    const claude = await usage.query("anthropic");
    expect(claude).toMatchObject({
      name: "anthropic",
      provider: "claude-fixture",
      weekly: { exhausted: true, span: "weekly", usedPercent: 100 },
    });
    expect(claude.weekly?.headroom.share).toBe(0);
  });
});

/** `agents.session` on the host engine, as a script outside a step would open one. */
function setHostSession(reviewer: AgentLike) {
  const engine = engines.at(-1);
  if (!engine) {
    throw new Error("no host engine");
  }
  return engine.agents.session(reviewer);
}

describe("what the session opens with", () => {
  it("has the skills and MCP tools chosen for the route usage picked", async () => {
    hostEngine();
    const reviewer = usageRoutedReviewer();

    const onClaude = parse((await reviewer.generate("Look.")).text);
    expect(onClaude.provider).toBe("claude-code");
    expect(onClaude.prompt).toContain("claude-checklist");
    expect(onClaude.prompt).not.toContain("codex-checklist");
    expect(onClaude.tools).toContain("fixture__echo");

    claudeWeekUsed = 100;
    const onCodex = parse((await reviewer.generate("Look.")).text);
    expect(onCodex.provider).toBe("codex");
    expect(onCodex.prompt).toContain("codex-checklist");
    expect(onCodex.prompt).not.toContain("claude-checklist");
    expect(onCodex.tools).not.toContain("fixture__echo");
  });

  it("streams on the built definition", async () => {
    hostEngine();
    const streamed = usageRoutedReviewer().stream("Look.");
    const chunks: string[] = [];
    for await (const event of streamed) {
      if (event.type === "text-delta") {
        chunks.push(event.delta);
      }
    }
    const text = await streamed.text;
    expect(parse(text).provider).toBe("claude-code");
    expect(chunks.join("")).toBe(text);
  });

  it("is what a step's own agents.session and generate use", async () => {
    hostEngine();
    const seen: AgentRoute[] = [];
    const reviewer = usageRoutedReviewer(seen);
    const review = step().do(async ({ agents }) => {
      const session = await agents.session(reviewer);
      const first = await session.generate("Look.");
      const direct = await reviewer
        .extend({ provider: "codex" })
        .generate("Go.");
      return [parse(first.text).provider, parse(direct.text).provider];
    });
    await expect(review.run()).resolves.toEqual(["claude-code", "codex"]);
    expect(seen).toEqual([{}, { provider: "codex" }]);
  });
});

describe("a definition object", () => {
  it("connects its MCP servers too, and extend keeps them", async () => {
    hostEngine();
    const reviewer = agent({ mcp: [fixtureServer], prompt: "Review." });
    expect(reviewer.mcp).toEqual([fixtureServer]);
    const onClaude = parse((await reviewer.generate("Look.")).text);
    expect(onClaude.tools).toContain("fixture__echo");
    const onCodex = reviewer.extend({ provider: "codex" });
    expect(onCodex.mcp).toBe(reviewer.mcp);
    const reply = parse((await onCodex.generate("Look.")).text);
    expect(reply.provider).toBe("codex");
    expect(reply.tools).toContain("fixture__echo");
  });
});

describe("extend", () => {
  it("gives the function the route it set, and its skills follow that route", async () => {
    hostEngine();
    const seen: AgentRoute[] = [];
    const reviewer = usageRoutedReviewer(seen);
    const pinned = reviewer.extend({ provider: "codex" });
    expect(pinned).toMatchObject({ id: reviewer.id, provider: "codex" });
    const reply = parse((await pinned.generate("Look.")).text);
    expect(reply.provider).toBe("codex");
    expect(reply.prompt).toContain("codex-checklist");
    expect(reply.tools).not.toContain("fixture__echo");
    expect(readLimits).not.toHaveBeenCalled();
    expect(seen).toEqual([{ provider: "codex" }]);
  });

  it("fails a function that returns another route than the one it was given", async () => {
    hostEngine();
    const reviewer = agent(() => ({
      prompt: "Review.",
      provider: "claude-code",
      skills: skills.none().add(claudeChecklist),
    }));
    await expect(
      reviewer.extend({ provider: "codex" }).generate("Look.")
    ).rejects.toThrow(ROUTE_CONFLICT);
  });

  it("fills in a route the function leaves out, and merges settings over what it returns", async () => {
    const reviewer = agent(() => ({
      prompt: "Review.",
      settings: {
        maxOutputTokens: 1000,
        output: verdict,
        providerOptions: { anthropic: { effort: "high" } },
      },
    }));
    const extended = reviewer
      .extend({ model: "gpt-5.5", provider: "codex" })
      .extend({
        settings: { providerOptions: { anthropic: { effort: "low" } } },
      })
      .extend({ settings: { temperature: 0.3 } });
    expect(Object.keys({ ...extended }).sort()).toEqual([
      "id",
      "kind",
      "model",
      "provider",
    ]);
    const built = await buildDefinition(extended);
    expect(built).toMatchObject({
      id: reviewer.id,
      kind: "agent",
      model: "gpt-5.5",
      prompt: "Review.",
      provider: "codex",
      settings: {
        maxOutputTokens: 1000,
        providerOptions: { anthropic: { effort: "low" } },
        temperature: 0.3,
      },
    });
    expect(built.settings?.output).toBe(verdict);
  });

  it("keeps the id and the catalog's declared agent", () => {
    const reviewer = agent(() => ({ prompt: "Review." }));
    const extended = reviewer.extend({ provider: "codex" });
    expect(extended.id).toBe(reviewer.id);
    expect(catalog.agents.get(reviewer.id)).toBe(reviewer);
    expect(topLevelReviewer.id).toBe("topLevelReviewer");
  });
});

describe("types", () => {
  it("types the agent after the output the function returns, sync or async", () => {
    const sync = agent(() => ({
      prompt: "Judge.",
      settings: { output: verdict },
    }));
    const later = agent(async () => {
      await Promise.resolve();
      return { prompt: "Judge.", settings: { output: verdict } };
    });
    const plain = agent(async () => ({ prompt: "Judge." }));
    expectTypeOf(sync).toEqualTypeOf<DeferredAgent<typeof verdict>>();
    expectTypeOf(later).toEqualTypeOf<DeferredAgent<typeof verdict>>();
    expectTypeOf(plain).toEqualTypeOf<DeferredAgent<never>>();
    expectTypeOf(later.extend({ provider: "codex" })).toEqualTypeOf<
      DeferredAgent<typeof verdict>
    >();
    // @ts-expect-error The id is fixed by agent(); the function cannot name it.
    agent(() => ({ name: "renamed", prompt: "Judge." }));
  });

  it("types a reply's output from the built definition", async () => {
    const engine = testEngine({
      print: () => undefined,
      reply: () => JSON.stringify({ approved: true }),
    });
    engines.push(engine);
    setHost(engine);
    const judge = agent(async () => ({
      prompt: "Judge.",
      settings: { output: verdict },
    }));
    const reply = await judge.generate("Approve?");
    expectTypeOf(reply.output).toEqualTypeOf<{ approved: boolean }>();
    expect(reply.output).toEqual({ approved: true });
  });
});

describe("failures", () => {
  it("rejects the call and files no session when the function throws", async () => {
    const deps = managerDeps();
    const a = args();
    const reviewer = agent(() => {
      throw new Error("usage could not be read");
    });
    await expect(
      new AgentsManager(deps).scoped(a).session(reviewer)
    ).rejects.toThrow("usage could not be read");
    expect(await deps.sessions.getSession(a.scope.session.id)).toBeNull();
    await expect(
      new AgentsManager(deps).turns(a).generate(reviewer, "Look.")
    ).rejects.toThrow("usage could not be read");
  });

  it("rejects a definition the function returns without a prompt, or with a name", async () => {
    const empty = agent(() => ({ prompt: " " }));
    await expect(buildDefinition(empty)).rejects.toThrow("returned no prompt");
    const named = agent(
      () => ({ name: "renamed", prompt: "Review." }) as never
    );
    await expect(buildDefinition(named)).rejects.toThrow(NO_NAME);
  });

  it("does not take a spread of the agent for a definition", async () => {
    const reviewer = agent(() => ({ prompt: "Review." }));
    await expect(
      new AgentsManager(managerDeps()).session({ ...reviewer })
    ).rejects.toThrow(NO_PROMPT);
  });

  it("fails the opening, and files nothing, when an MCP server cannot connect", async () => {
    const deps = managerDeps();
    const a = args();
    const missing: AgentMcpServer = {
      id: "missing",
      transport: { command: "marbles-no-such-mcp-server", kind: "stdio" },
    };
    const reviewer = agent(() => ({
      mcp: [fixtureServer, missing],
      prompt: "Review.",
    }));
    await expect(
      new AgentsManager(deps).scoped(a).session(reviewer)
    ).rejects.toThrow(NOT_CONNECTED);
    expect(await deps.sessions.getSession(a.scope.session.id)).toBeNull();
  });

  it("refuses MCP servers on a sandbox session", async () => {
    const reviewer = agent(() => ({ mcp: [fixtureServer], prompt: "Review." }));
    const sandbox = { exec: () => undefined } as never;
    await expect(
      new AgentsManager(managerDeps()).scoped(args()).session(reviewer, {
        sandbox,
      })
    ).rejects.toThrow(SANDBOX_MCP);
  });

  it("opens nothing, and closes its servers, when the step is cancelled while an MCP server connects", async () => {
    const deps = managerDeps();
    const a = args();
    const slowServer: AgentMcpServer = {
      ...fixtureServer,
      id: "slow",
      transport: {
        ...fixtureServer.transport,
        args: [
          ...(fixtureServer.transport.kind === "stdio"
            ? (fixtureServer.transport.args ?? [])
            : []),
          "600",
        ],
      } as AgentMcpServer["transport"],
    };
    const closed = vi.spyOn(McpClient.prototype, "close");
    const reviewer = agent(() => ({
      mcp: [fixtureServer, slowServer],
      prompt: "Review.",
    }));
    const opening = new AgentsManager(deps).scoped(a).session(reviewer);
    setTimeout(
      () => a.frame.controller.abort(new Error("step cancelled")),
      200
    );
    await expect(opening).rejects.toThrow("step cancelled");
    expect(await deps.sessions.getSession(a.scope.session.id)).toBeNull();
    const clients = closed.mock.contexts as McpClient[];
    expect(new Set(clients.map((client) => client.id))).toEqual(
      new Set(["fixture", "slow"])
    );
    expect(clients.every((client) => client.status === "off")).toBe(true);
    closed.mockRestore();
  });

  it("opens nothing when the step is cancelled while the function runs", async () => {
    const deps = managerDeps();
    const a = args();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const reviewer = agent(async () => {
      await gate;
      return { prompt: "Review." };
    });
    const opening = new AgentsManager(deps).scoped(a).session(reviewer);
    a.frame.controller.abort(new Error("step cancelled"));
    release();
    await expect(opening).rejects.toThrow("step cancelled");
    expect(await deps.sessions.getSession(a.scope.session.id)).toBeNull();
  });
});

describe("identity", () => {
  /** A helper that makes one agent per team: the same source, different captures. */
  function teamReviewer(team: string) {
    return agent(() => ({ prompt: `Review for ${team}.` }));
  }

  it("refuses a second agent from the same source rather than merging them", async () => {
    const forA = teamReviewer("A");
    expect(() => teamReviewer("B")).toThrow(ANOTHER_FUNCTION);
    expect(catalog.agents.get(forA.id)).toBe(forA);
    expect(catalog.agents.size).toBe(1);
    await expect(buildDefinition(forA)).resolves.toMatchObject({
      prompt: "Review for A.",
    });
  });

  it("lets the same function be declared again as the same agent", () => {
    const define = () => ({ prompt: "Review." });
    const first = agent(define);
    const again = agent(define);
    expect(again.id).toBe(first.id);
    expect(catalog.agents.size).toBe(1);
  });

  it("keeps static agents from one helper apart by their prompts", () => {
    const make = (team: string) => agent({ prompt: `Review for ${team}.` });
    expect(make("A").id).not.toBe(make("B").id);
    expect(make("A").id).toBe(make("A").id);
  });
});

describe("replay", () => {
  it("continues a recorded session on its provider when usage has moved", async () => {
    const deps = managerDeps();
    const a = args();
    const seen: AgentRoute[] = [];
    let fromUsage = "claude-code";
    const reviewer = agent((route) => {
      seen.push(route);
      return { prompt: "Review.", provider: route.provider ?? fromUsage };
    });
    const first = await new AgentsManager(deps).scoped(a).session(reviewer);
    fromUsage = "codex";
    await a.scope.enter(a.frame);
    const replayed = await new AgentsManager(deps).scoped(a).session(reviewer);
    expect(replayed.ref).toEqual(first.ref);
    expect(replayed.ref.provider).toBe("claude-code");
    expect(seen).toEqual([{}, { provider: "claude-code" }]);
  });

  it("returns a recorded one-turn reply without running the function", async () => {
    const deps = managerDeps();
    const a = args();
    const define = vi.fn(() => ({ prompt: "Review." }));
    const reviewer = agent(define);
    const first = await new AgentsManager(deps)
      .turns(a)
      .generate(reviewer, "Look.");
    await a.scope.enter(a.frame);
    const replayed = await new AgentsManager(deps)
      .turns(a)
      .generate(reviewer, "Look.");
    expect(replayed.text).toBe(first.text);
    expect(define).toHaveBeenCalledOnce();
  });
});

describe("input", () => {
  /** A reviewer told who did the work; the session keeps who that was. */
  function reviewerOf(seen: unknown[] = []) {
    return agent((_route, input?: { readonly implementer: string }) => {
      seen.push(input);
      return {
        prompt: `Review what ${input?.implementer ?? "someone"} did.`,
      };
    });
  }

  it("gives the function the input extend set, and undefined without one", async () => {
    hostEngine();
    const seen: unknown[] = [];
    const reviewer = reviewerOf(seen);
    const ofCodex = reviewer.extend({ input: { implementer: "codex" } });
    expect(ofCodex.id).toBe(reviewer.id);
    expect({ ...ofCodex }).toEqual({
      id: reviewer.id,
      input: { implementer: "codex" },
      kind: "agent",
    });

    expect(parse((await ofCodex.generate("Look.")).text).prompt).toContain(
      "Review what codex did."
    );
    await reviewer.generate("Look.");
    expect(seen).toEqual([{ implementer: "codex" }, undefined]);
  });

  it("keeps the input through a later extend, replaces it, and clears it with undefined", async () => {
    const reviewer = reviewerOf();
    const ofCodex = reviewer.extend({ input: { implementer: "codex" } });
    const routed = ofCodex.extend({ provider: "codex" });
    expect(routed.input).toEqual({ implementer: "codex" });
    expect(routed.extend({ input: { implementer: "claude" } }).input).toEqual({
      implementer: "claude",
    });
    const cleared = routed.extend({ input: undefined });
    expect(Object.keys({ ...cleared }).sort()).toEqual([
      "id",
      "kind",
      "provider",
    ]);
    expect(
      (await buildDefinition(routed.extend({ input: { implementer: "pi" } })))
        .prompt
    ).toBe("Review what pi did.");
  });

  it("must be JSON, so a session can keep it", () => {
    const reviewer = agent((_route, input?: Record<string, unknown>) => ({
      prompt: `Review ${Object.keys(input ?? {}).join(", ")}.`,
    }));
    expect(() => reviewer.extend({ input: { at: new Date() } })).toThrow(
      NOT_JSON
    );
    expect(() => reviewer.extend({ input: { later: undefined } })).toThrow(
      NOT_JSON
    );
    expect(() => reviewer.extend({ input: { run: () => 0 } })).toThrow(
      NOT_JSON
    );
    // An array with holes would not come back from JSON the same.
    expect(() => reviewer.extend({ input: { list: new Array(2) } })).toThrow(
      NOT_JSON
    );
    expect(() => reviewer.extend({ input: { list: new Array(1) } })).toThrow(
      NOT_JSON
    );
    expect(() => reviewer.extend({ input: { list: [new Array(1)] } })).toThrow(
      NOT_JSON
    );
    const listed = agent((_route, input?: unknown[]) => ({
      prompt: `Review ${input?.length}.`,
    }));
    expect(() => listed.extend({ input: new Array(1) })).toThrow(NOT_JSON);
    expect(listed.extend({ input: [] }).input).toEqual([]);
  });

  it("can be null, which a session keeps apart from no input", async () => {
    const deps = managerDeps();
    const seen: unknown[] = [];
    const nullable = agent((_route, input?: { who: string } | null) => {
      seen.push(input);
      return { prompt: `Review ${input?.who}.` };
    });
    const ofNull = nullable.extend({ input: null });
    expect(ofNull.input).toBeNull();
    const first = await new AgentsManager(deps).scoped(args()).session(ofNull);
    expect(first.ref.input).toBeNull();
    expect(first.ref.noInput).toBeUndefined();

    // Reopened without an input, the function is given the null it kept.
    const kept = JSON.parse(JSON.stringify(first.ref));
    const reopened = await new AgentsManager(deps)
      .scoped(args())
      .session(nullable, { session: kept });
    expect(reopened.ref).toEqual(first.ref);
    const same = await new AgentsManager(deps)
      .scoped(args())
      .session(ofNull, { session: kept });
    expect(same.ref).toEqual(first.ref);
    expect(seen).toEqual([null, null, null]);
    await expect(
      new AgentsManager(deps)
        .scoped(args())
        .session(nullable.extend({ input: { who: "alice" } }), {
          session: kept,
        })
    ).rejects.toThrow(ANOTHER_INPUT);

    // A session opened with none does not take null.
    const none = await new AgentsManager(deps).scoped(args()).session(nullable);
    expect(none.ref.noInput).toBe(true);
    await expect(
      new AgentsManager(deps)
        .scoped(args())
        .session(ofNull, { session: JSON.parse(JSON.stringify(none.ref)) })
    ).rejects.toThrow(ANOTHER_INPUT);
  });

  it("keeps a frozen copy, so changing the object given changes nothing", async () => {
    const deps = managerDeps();
    const seen: unknown[] = [];
    const reviewer = reviewerOf(seen);
    const given = { implementer: "codex" };
    const ofCodex = reviewer.extend({ input: given });
    const first = await new AgentsManager(deps).scoped(args()).session(ofCodex);
    await first.generate("Look.");
    given.implementer = "claude";

    expect(ofCodex.input).toEqual({ implementer: "codex" });
    expect(first.ref.input).toEqual({ implementer: "codex" });
    expect(Object.isFrozen(ofCodex.input)).toBe(true);
    expect(Object.isFrozen(first.ref.input)).toBe(true);
    expect(Object.isFrozen(seen[0])).toBe(true);
    await expect(
      new AgentsManager(deps)
        .scoped(args())
        .session(reviewer.extend({ input: given }), { session: first.ref })
    ).rejects.toThrow(ANOTHER_INPUT);

    // An input read back from a ref is frozen for the function too.
    const reopened = await new AgentsManager(deps)
      .scoped(args())
      .session(reviewer, { session: JSON.parse(JSON.stringify(first.ref)) });
    expect(reopened.ref.input).toEqual({ implementer: "codex" });
    expect(Object.isFrozen(seen.at(-1))).toBe(true);
  });

  it("keeps that a session opened with no input, so reopening it with one fails", async () => {
    const deps = managerDeps();
    const a = args();
    const seen: unknown[] = [];
    const reviewer = reviewerOf(seen);
    const first = await new AgentsManager(deps).scoped(a).session(reviewer);
    await first.generate("Look.");
    expect(first.ref.noInput).toBe(true);
    expect(first.ref).not.toHaveProperty("input");
    const different = reviewer.extend({ input: { implementer: "different" } });

    await expect(
      new AgentsManager(deps)
        .scoped(args())
        .session(different, { session: first.ref })
    ).rejects.toThrow(ANOTHER_INPUT);
    const again = await new AgentsManager(deps)
      .scoped(args())
      .session(reviewer, { session: first.ref });
    expect(again.ref).toEqual(first.ref);
    expect(seen).toEqual([undefined, undefined]);

    // The same in a parked run whose body now binds an input.
    const restored = new RunScope(
      a.scope.id,
      a.scope.cwd,
      {},
      {
        ledger: JSON.parse(JSON.stringify(a.scope.ledger)),
        session: a.scope.session,
      }
    );
    await expect(
      new AgentsManager(deps)
        .scoped({
          frame: restored.frame(["root", "review"]),
          scope: restored,
          write: () => 0,
        })
        .session(different)
    ).rejects.toThrow(ANOTHER_INPUT);
  });

  it("is kept with the session, so a parked run gives the function the same input", async () => {
    const deps = managerDeps();
    const a = args();
    const seen: unknown[] = [];
    const reviewer = reviewerOf(seen);
    const ofCodex = reviewer.extend({ input: { implementer: "codex" } });
    const first = await new AgentsManager(deps).scoped(a).session(ofCodex);
    expect(first.ref.input).toEqual({ implementer: "codex" });

    // The run parks: its ledger is written as JSON, and a later process
    // rebuilds the scope from it. The body runs again without the input.
    const restored = new RunScope(
      a.scope.id,
      a.scope.cwd,
      {},
      {
        ledger: JSON.parse(JSON.stringify(a.scope.ledger)),
        session: a.scope.session,
      }
    );
    const again: ManagerArgs = {
      frame: restored.frame(["root", "review"]),
      scope: restored,
      write: () => 0,
    };
    const replayed = await new AgentsManager(deps)
      .scoped(again)
      .session(reviewer);
    expect(replayed.ref).toEqual(first.ref);
    expect(seen).toEqual([{ implementer: "codex" }, { implementer: "codex" }]);
  });

  it("replays a body that gives the same input again, in any key order", async () => {
    const deps = managerDeps();
    const a = args();
    const reviewer = agent(
      (
        _route,
        input?: { readonly implementer: string; readonly round: number }
      ) => ({
        prompt: `Review round ${input?.round} by ${input?.implementer}.`,
      })
    );
    const first = await new AgentsManager(deps)
      .scoped(a)
      .session(reviewer.extend({ input: { implementer: "codex", round: 2 } }));
    const restored = new RunScope(
      a.scope.id,
      a.scope.cwd,
      {},
      {
        ledger: JSON.parse(JSON.stringify(a.scope.ledger)),
        session: a.scope.session,
      }
    );
    const replayed = await new AgentsManager(deps)
      .scoped({
        frame: restored.frame(["root", "review"]),
        scope: restored,
        write: () => 0,
      })
      .session(reviewer.extend({ input: { implementer: "codex", round: 2 } }));
    expect(replayed.ref).toEqual(first.ref);
  });

  it("is given again when a kept session reopens, and another input fails it", async () => {
    const deps = managerDeps();
    const seen: unknown[] = [];
    const reviewer = reviewerOf(seen);
    const first = await new AgentsManager(deps)
      .scoped(args())
      .session(reviewer.extend({ input: { implementer: "codex" } }));

    const reopened = await new AgentsManager(deps)
      .scoped(args())
      .session(reviewer, { session: first.ref });
    expect(reopened.ref.input).toEqual({ implementer: "codex" });
    expect(seen.at(-1)).toEqual({ implementer: "codex" });

    await expect(
      new AgentsManager(deps)
        .scoped(args())
        .session(reviewer.extend({ input: { implementer: "claude" } }), {
          session: first.ref,
        })
    ).rejects.toThrow(ANOTHER_INPUT);

    // A ref that kept no input takes the one the agent has.
    const byId = await new AgentsManager(deps)
      .scoped(args())
      .session(reviewer.extend({ input: { implementer: "claude" } }), {
        session: { id: first.ref.id },
      });
    expect(byId.ref.input).toEqual({ implementer: "claude" });
  });

  it("types the input from the function's parameter", () => {
    const reviewer = reviewerOf();
    expectTypeOf(reviewer).toEqualTypeOf<
      DeferredAgent<never, { readonly implementer: string }>
    >();
    expectTypeOf(reviewer.extend({ provider: "codex" })).toEqualTypeOf<
      DeferredAgent<never, { readonly implementer: string }>
    >();
    // @ts-expect-error The input is the type the function takes.
    reviewer.extend({ input: { implementer: 1 } });
    const routed = agent(() => ({ prompt: "Review." }));
    expectTypeOf(routed).toEqualTypeOf<DeferredAgent<never>>();
    // @ts-expect-error A function that takes no input is given none.
    routed.extend({ input: { implementer: "codex" } });
    const plain = agent({ prompt: "Review." });
    // @ts-expect-error A definition object has no function to give an input.
    plain.extend({ input: { implementer: "codex" } });
    const typed = agent<typeof verdict, { readonly implementer: string }>(
      (_route, input) => ({
        prompt: `Judge ${input?.implementer}.`,
        settings: { output: verdict },
      })
    );
    expectTypeOf(typed.input).toEqualTypeOf<
      { readonly implementer: string } | undefined
    >();
  });
});

describe("an MCP dispatch", () => {
  it("builds a declared agent for the route the dispatch asks for", async () => {
    const engine = testEngine({
      print: () => undefined,
      reply: ({ executor, prompt }) => `${executor.provider}|${prompt}`,
    });
    engines.push(engine);
    const seen: AgentRoute[] = [];
    const declared = usageRoutedReviewer(seen);
    const jobs = new BackgroundRuns(engine, catalog);
    await engine.start();
    const started = await jobs.start({
      agent: declared.id,
      instructions: "Inspect only.",
      prompt: "Inspect",
      provider: "codex",
    });
    await vi.waitFor(async () =>
      expect((await jobs.get(started.runId)).status).toBe("completed")
    );
    const { text } = await jobs.get(started.runId);
    expect(text?.startsWith("codex|")).toBe(true);
    expect(text).toContain("Review the change.\n\nInspect only.");
    expect(text).toContain("codex-checklist");
    expect(seen).toEqual([{ provider: "codex" }]);
    await jobs.close();
  });

  it("gives a continued session the input it kept", async () => {
    const engine = testEngine({
      print: () => undefined,
      reply: ({ prompt }) => prompt,
    });
    engines.push(engine);
    const seen: unknown[] = [];
    const declared = agent((_route, input?: { readonly who: string }) => {
      seen.push(input);
      return { prompt: `Review what ${input?.who ?? "someone"} did.` };
    });
    const opened = await engine.agents.session(
      declared.extend({ input: { who: "alice" } })
    );
    const jobs = new BackgroundRuns(engine, catalog);
    await engine.start();
    // The ref comes back over MCP as JSON, through the dispatch schema.
    const { session } = dispatchSchema.parse({
      agent: declared.id,
      prompt: "Continue",
      session: JSON.parse(JSON.stringify(opened.ref)),
    });
    const started = await jobs.start({
      agent: declared.id,
      instructions: "Inspect only.",
      prompt: "Continue",
      ...(session === undefined ? {} : { session }),
    });
    await vi.waitFor(async () =>
      expect((await jobs.get(started.runId)).status).toBe("completed")
    );
    const finished = await jobs.get(started.runId);
    expect(seen).toEqual([{ who: "alice" }, { who: "alice" }]);
    expect(finished.session).toEqual(opened.ref);
    expect(finished.text).toContain("Review what alice did.\n\nInspect only.");
    await jobs.close();
  });
});
