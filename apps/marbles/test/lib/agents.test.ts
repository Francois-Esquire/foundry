import { createInMemoryAgentAuthorizer } from "@foundry/agents/authorization";
import type { HarnessSession } from "@foundry/agents/harness";
import type { SessionEvent } from "@foundry/agents/session";
import { Sessions } from "@foundry/agents/session";
import { InMemorySessionStore } from "@foundry/agents/store/memory";
import { ModelManager } from "@foundry/models";
import { airplaneMode } from "@foundry/models/airplane";
import { NoObjectGeneratedError, Output } from "ai";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import type { ManagerArgs } from "~/lib/bindings";
import { CLAUDE_CODE, CODEX } from "~/lib/harnesses";
import type { AgentsDeps } from "~/lib/managers/agents";
import { AgentsManager, policed } from "~/lib/managers/agents";
import { echoModels, mockModels } from "~/lib/models/echo";
import { RunScope } from "~/lib/run-scope";
import type { AgentDefinition, SandboxHandle } from "~/lib/types";
import { testEngine } from "../helpers/engine";

const NO_TURN_PATTERN = /no agent turn is running/;

function args(): ManagerArgs & { readonly written: string[] } {
  const scope = new RunScope(`run-${Math.random()}`, "/tmp/project");
  const frame = scope.frame(["root", "review"]);
  const written: string[] = [];
  return {
    frame,
    scope,
    write: (value) => written.push(String(value)),
    written,
  };
}

/** Supplies the approvals, activity, and automations an engine would hand the manager. */
const host = testEngine();

function deps(warnings: string[] = []): AgentsDeps {
  const models = mockModels(
    [CLAUDE_CODE, CODEX],
    ({ executor, prompt, cwd }) => `${executor.provider}@${cwd}: ${prompt}`
  );
  return {
    activities: host.activities,
    automations: host.automations,
    containerOf: (): never => {
      throw new Error("no sandbox in these tests");
    },
    defaultExecutor: () => CLAUDE_CODE,
    dry: false,
    interactions: host.interactions,
    models,
    root: process.cwd(),
    sessions: new InMemorySessionStore(),
    skills: () => Promise.resolve([]),
    warn: (message: string) => {
      warnings.push(message);
    },
  };
}

const reviewer: AgentDefinition = {
  id: "agent#1",
  kind: "agent",
  prompt: "Review without editing.",
};

describe("agents.session", () => {
  it("dry sandbox sessions use echo models without preparing a guest or reading credentials", async () => {
    const a = args();
    const session = await new AgentsManager({ ...deps(), dry: true })
      .scoped(a)
      .session(reviewer, {
        sandbox: {
          close: () => Promise.resolve(),
          exec: () => {
            throw new Error("Dry session must not execute guest commands");
          },
          id: "dry-sandbox",
        } as unknown as SandboxHandle,
      });
    expect((await session.generate("Inspect the fixture")).text).toContain(
      "Inspect the fixture"
    );
  });

  it("rejects sandbox-only permission and credential options on a host session", async () => {
    const agents = new AgentsManager(deps()).scoped(args());
    const authority = { policy: createInMemoryAgentAuthorizer().authorizer };
    for (const options of [
      { authority },
      { apiKey: "explicit-key" },
      { oauthToken: "explicit-token" },
      {
        profile: {
          allowedTools: [],
          disallowedTools: [],
          maxSteps: 8,
          mode: "attended" as const,
          unresolved: "ask" as const,
        },
      },
    ]) {
      // @ts-expect-error Exercise invalid JavaScript callers at the boundary.
      await expect(agents.session(reviewer, options)).rejects.toThrow(
        "require a sandbox session"
      );
    }
  });

  it("refuses an explicitly selected unavailable provider rather than routing elsewhere", async () => {
    const d = deps();
    const models = new ModelManager({
      providers: d.models.providers
        .filter((provider) => provider.id === CLAUDE_CODE.provider)
        .map((provider) => ({ ...provider, available: false })),
    });
    const manager = new AgentsManager({ ...d, models });
    const definition = {
      ...reviewer,
      model: CLAUDE_CODE.model,
      provider: CLAUDE_CODE.provider,
    };
    try {
      await expect(manager.session(definition)).rejects.toThrow(
        `Provider "${CLAUDE_CODE.provider}" is unavailable`
      );
      await expect(manager.scoped(args()).session(definition)).rejects.toThrow(
        `Provider "${CLAUDE_CODE.provider}" is unavailable`
      );
    } finally {
      await manager.close();
    }
  });

  it.each([false, true])(
    "rejects widened sandbox options with maxTurns (dry=%s)",
    async (dry) => {
      const manager = new AgentsManager({ ...deps(), dry });
      const sandbox = { id: "sandbox-turn-limit" } as unknown as SandboxHandle;
      const widened = { maxTurns: 3, sandbox };
      try {
        // @ts-expect-error Exercise widened options from JavaScript callers.
        await expect(manager.session(reviewer, widened)).rejects.toThrow(
          "maxTurns is not supported for sandbox sessions"
        );
        // @ts-expect-error The scoped entry must reject the same invalid options.
        const scoped = manager.scoped(args()).session(reviewer, widened);
        await expect(scoped).rejects.toThrow(
          "maxTurns is not supported for sandbox sessions"
        );
      } finally {
        await manager.close();
      }
    }
  );

  it("opens a session on the default provider in the frame's directory and streams text", async () => {
    const a = args();
    const agents = new AgentsManager(deps()).scoped(a);
    const session = await agents.session(reviewer);
    const reply = await session.generate("Look at src.");
    expect(reply.text.startsWith("claude-code@/tmp/project:")).toBe(true);
    expect(reply.text).toContain("Look at src.");
    expect(session.ref).toEqual({
      id: expect.any(String),
      model: expect.any(String),
      provider: "claude-code",
    });
    expect(a.written.join("")).toBe(reply.text);
  });

  it("a fresh session belongs to the run's session in the store", async () => {
    const a = args();
    const d = deps();
    const agents = new AgentsManager(d).scoped(a);
    const session = await agents.session(reviewer);
    const stored = await d.sessions.getSession(session.ref.id);
    expect(stored?.parentSessionId).toBe(a.scope.session.id);
    expect(await d.sessions.getSession(a.scope.session.id)).not.toBeNull();
    // Continuing a session by reference does not re-parent it.
    const other = args();
    const again = await new AgentsManager(d)
      .scoped(other)
      .session(reviewer, { session });
    expect(again.ref.id).toBe(session.ref.id);
    expect((await d.sessions.getSession(session.ref.id))?.parentSessionId).toBe(
      a.scope.session.id
    );
  });

  it("honours provider and cwd overrides", async () => {
    const a = args();
    const agents = new AgentsManager(deps()).scoped(a);
    const session = await agents.session(
      { ...reviewer, provider: "codex" },
      { cwd: "/elsewhere" }
    );
    const reply = await session.generate("hi");
    expect(reply.text.startsWith("codex@/elsewhere:")).toBe(true);
    expect(reply.text).toContain("hi");
    expect(session.ref.provider).toBe("codex");
  });

  it("continues a session by reference, and refuses to move it to another provider", async () => {
    const agents = new AgentsManager(deps()).scoped(args());
    const first = await agents.session(reviewer);
    const again = await agents.session(reviewer, { session: first.ref });
    expect(again.ref.id).toBe(first.ref.id);
    const viaSession = await agents.session(reviewer, { session: first });
    expect(viaSession.ref.id).toBe(first.ref.id);

    await expect(
      agents.session({ ...reviewer, provider: "codex" }, { session: first.ref })
    ).rejects.toMatchObject({ code: "SESSION_ROUTE_CONFLICT" });
  });

  it("returns the recorded session when the body replays", async () => {
    const a = args();
    const agents = new AgentsManager(deps()).scoped(a);
    const first = await agents.session(reviewer);
    const second = await agents.session(reviewer);
    expect(second.ref.id).not.toBe(first.ref.id);
    await a.scope.enter(a.frame);
    const replayedFirst = await agents.session(reviewer);
    const replayedSecond = await agents.session(reviewer);
    expect(replayedFirst.ref.id).toBe(first.ref.id);
    expect(replayedSecond.ref.id).toBe(second.ref.id);
  });

  it("aborts a turn with the frame", async () => {
    const a = args();
    const agents = new AgentsManager(deps()).scoped(a);
    const session = await agents.session(reviewer);
    a.frame.controller.abort(new Error("step cancelled"));
    await expect(session.generate("hi")).rejects.toThrow("step cancelled");
  });

  it("a turn cut short by the step's abort does not return to the body", async () => {
    const a = args();
    const models = mockModels(
      [CLAUDE_CODE],
      ({ prompt }) => `reply to ${prompt}`,
      {
        hold: ({ prompt }) => prompt.endsWith("slowly"),
      }
    );
    const agents = new AgentsManager({ ...deps(), models }).scoped(a);
    const session = await agents.session(reviewer);
    const turn = session.generate("count slowly");
    await new Promise((resolve) => setTimeout(resolve, 20));
    a.frame.controller.abort(new Error("paused"));
    await expect(turn).rejects.toThrow("paused");

    const b = args();
    const streaming = new AgentsManager({ ...deps(), models }).scoped(b);
    const streamed = (await streaming.session(reviewer)).stream("speak slowly");
    await new Promise((resolve) => setTimeout(resolve, 20));
    b.frame.controller.abort(new Error("paused"));
    await expect(streamed.message).rejects.toThrow("paused");
    await expect(streamed.text).rejects.toThrow("paused");
  });

  it("a steer stops the running turn and the prompt becomes the next one", async () => {
    const a = args();
    const models = mockModels(
      [CLAUDE_CODE],
      ({ prompt }) => `reply to ${prompt.split("\n").at(-1) ?? ""}`,
      { hold: ({ prompt }) => prompt.endsWith("count slowly") }
    );
    const agents = new AgentsManager({ ...deps(), models }).scoped(a);
    const session = await agents.session(reviewer);
    const turn = session.generate("count slowly");
    // The turn is streaming its first word; hand the agent a new prompt.
    await new Promise((resolve) => setTimeout(resolve, 20));
    a.scope.steer(a.frame.key, "stop and summarise");
    const reply = await turn;
    expect(reply.text).toBe("reply to stop and summarise");
    expect(a.written.join("")).toContain("[steer] stop and summarise");
    // Nothing in flight afterwards, so a second steer has nothing to catch.
    expect(() => a.scope.steer(a.frame.key, "again")).toThrow(NO_TURN_PATTERN);
  });

  it("steers streaming replies and exposes only the final turn through every final promise", async () => {
    const a = args();
    const seen: string[] = [];
    const models = mockModels(
      [CLAUDE_CODE],
      ({ prompt }) => {
        const text = prompt.split("\n").at(-1) ?? "";
        seen.push(text);
        return `reply to ${text}`;
      },
      { hold: ({ prompt }) => prompt.endsWith("count slowly") }
    );
    const manager = new AgentsManager({ ...deps(), models });
    const session = await manager.scoped(a).session(reviewer);
    try {
      const stream = session.stream("count slowly");
      const events = (async () => {
        const values: SessionEvent[] = [];
        for await (const event of stream) {
          values.push(event);
        }
        return values;
      })();
      await new Promise((resolve) => setTimeout(resolve, 20));
      a.scope.steer(a.frame.key, "stop and summarise");
      expect(await stream.text).toBe("reply to stop and summarise");
      expect((await stream.message).parts).toContainEqual({
        text: "reply to stop and summarise",
        type: "text",
      });
      expect(await stream.outcome).toBe("complete");
      expect(await stream.usage).toBeDefined();
      expect(
        (await events).filter((event) => event.type === "finish")
      ).toHaveLength(1);
      expect(seen).toEqual(["count slowly", "stop and summarise"]);
      expect(a.frame.sessions[0]?.steer).toBeUndefined();
      expect(() => a.scope.steer(a.frame.key, "again")).toThrow(
        NO_TURN_PATTERN
      );
    } finally {
      await a.scope.settle();
      await manager.close();
    }
  });

  it("a resume prompt rides on the first turn of the session that was parked", async () => {
    const a = args();
    const seen: string[] = [];
    const models = mockModels([CLAUDE_CODE], ({ prompt }) => {
      seen.push(prompt);
      return "ok";
    });
    const agents = new AgentsManager({ ...deps(), models }).scoped(a);
    await agents.session(reviewer);
    // Replay: the same call returns the recorded session; the host left a prompt.
    await a.scope.enter(a.frame);
    a.frame.resumePrompt = "focus on the tests";
    const session = await agents.session(reviewer);
    await session.generate("continue the review");
    await session.generate("and then?");
    expect(seen[0]).toContain("focus on the tests\n\ncontinue the review");
    expect(seen[1]).not.toContain("focus on the tests\n\nand then?");
    expect(a.written.join("")).toContain("[resume] focus on the tests");
  });
});

describe("structured output", () => {
  const verdict = Output.object({
    schema: z.object({
      approved: z.boolean(),
      notes: z.array(z.string()),
      severity: z.enum(["low", "high"]),
    }),
  });

  function structured(reply: (call: { schema?: unknown }) => string) {
    return new AgentsManager({
      ...deps(),
      models: mockModels([CLAUDE_CODE, CODEX], reply),
    }).scoped(args());
  }

  it("returns the parsed value of a turn's output", async () => {
    const agents = structured(({ schema }) =>
      schema ? '{"approved":true,"notes":["ok"],"severity":"low"}' : "plain"
    );
    const session = await agents.session(reviewer);
    const reply = await session.generate("Review.", { output: verdict });
    expect(reply.output).toEqual({
      approved: true,
      notes: ["ok"],
      severity: "low",
    });
    expect(reply.usage.totalTokens).toBeGreaterThan(0);
    expect(reply.result).toBeDefined();
    expect((await session.generate("Again.")).text).toBe("plain");
  });

  it("starts every turn from the agent's settings", async () => {
    const agents = structured(
      () => '{"approved":false,"notes":[],"severity":"high"}'
    );
    const session = await agents.session({
      ...reviewer,
      settings: { output: verdict },
    });
    const { output } = await session.generate("Review.");
    expect(output.severity).toBe("high");
  });

  it("rejects a turn whose output does not match, after committing it", async () => {
    const agents = structured(() => "not json");
    const session = await agents.session(reviewer);
    await expect(
      session.generate("Review.", { output: verdict })
    ).rejects.toSatisfy(NoObjectGeneratedError.isInstance);
    const stored = await session.harness.store.listMessages(session.ref.id);
    expect(stored.at(-1)?.role).toBe("assistant");
  });

  it("answers a dry turn with the smallest value the schema accepts", async () => {
    const printed: string[] = [];
    const agents = new AgentsManager({
      ...deps(),
      dry: true,
      models: echoModels([CLAUDE_CODE, CODEX], (line) => printed.push(line)),
    }).scoped(args());
    const session = await agents.session(reviewer);
    const { output } = await session.generate("Review.", { output: verdict });
    expect(output).toEqual({ approved: false, notes: [], severity: "low" });
    expect(printed.at(-1)).toContain("→ { approved, notes, severity }");
  });
});

describe("guest sessions and policies", () => {
  const sandbox = { id: "guest" } as unknown as SandboxHandle;

  it("refuses a model the CLI's catalog does not list, before any guest starts", async () => {
    const manager = new AgentsManager(deps());
    try {
      await expect(
        manager.session(
          { ...reviewer, model: "unlisted", provider: CODEX.provider },
          { sandbox }
        )
      ).rejects.toThrow('No configured provider lists "unlisted"');
    } finally {
      await manager.close();
    }
  });

  it("refuses a guest CLI the policy refuses, before any guest starts", async () => {
    const d = deps();
    airplaneMode(d.models).set(true);
    const manager = new AgentsManager(d);
    try {
      await expect(
        manager.session(
          { ...reviewer, model: CODEX.model, provider: CODEX.provider },
          { sandbox }
        )
      ).rejects.toThrow("refused by airplane");
    } finally {
      await manager.close();
    }
  });

  it("checks each guest turn and interrupts the one in flight when a policy refuses", async () => {
    const { models } = deps();
    const resolution = models.resolve("text", CODEX);
    resolution.hold();
    let interrupted = 0;
    const session = {
      generate: () => Promise.resolve({}),
      interrupt: () => {
        interrupted += 1;
        return Promise.resolve();
      },
    } as unknown as HarnessSession;
    const closers: (() => unknown)[] = [];
    const site = {
      retain: ({ close }: { close: () => unknown }) => closers.push(close),
    } as unknown as Parameters<typeof policed>[3];
    const guarded = policed(session, resolution, models, site);
    await expect(guarded.generate("hi")).resolves.toEqual({});

    airplaneMode(models).set(true);

    expect(interrupted).toBe(1);
    expect(() => guarded.generate("again")).toThrow("refused by airplane");
    for (const close of closers) {
      close();
    }
  });
});

describe("pinned sessions", () => {
  const opus = { ...reviewer, model: "opus" };

  it("keeps a session's route when providers are reordered, and stamps its implementation", async () => {
    const d = { ...deps(), implementationOf: (id: string) => id };
    const agents = new AgentsManager(d).scoped(args());
    const first = await agents.session(opus);
    expect(first.ref).toMatchObject({
      implementation: "claude-code",
      model: "opus",
      provider: "claude-code",
    });
    d.models.setProviders([...d.models.providers].reverse());
    const again = await agents.session(reviewer, { session: first.ref });
    expect(again.ref.provider).toBe("claude-code");
  });

  it("continues a session whose agent names its model as provider/model, and refuses one that now names another", async () => {
    const qualified = { ...reviewer, model: "codex/gpt-5.5" };
    const agents = new AgentsManager(deps()).scoped(args());
    const first = await agents.session(qualified);
    expect(first.ref).toMatchObject({ model: "gpt-5.5", provider: "codex" });
    const again = await agents.session(qualified, { session: first.ref });
    expect(again.ref).toMatchObject({ model: "gpt-5.5", provider: "codex" });
    const replayed = await agents.session(
      { ...qualified, provider: "codex" },
      { session: first.ref }
    );
    expect(replayed.ref.provider).toBe("codex");
    await expect(
      agents.session(
        { ...reviewer, model: "claude-code/opus" },
        { session: first.ref }
      )
    ).rejects.toMatchObject({ code: "SESSION_ROUTE_CONFLICT" });
  });

  it("fails rather than reroutes when the provider left or the model was delisted", async () => {
    const d = deps();
    const agents = new AgentsManager(d).scoped(args());
    const first = await agents.session(opus);
    await expect(
      agents.session(reviewer, {
        session: { ...first.ref, model: "retired-model" },
      })
    ).rejects.toThrow('No configured provider lists "retired-model"');
    d.models.setProviders(
      d.models.providers.filter((provider) => provider.id !== "claude-code")
    );
    await expect(
      agents.session(reviewer, { session: first.ref })
    ).rejects.toThrow('Provider "claude-code" is not configured');
  });

  it("refuses a session whose provider id now names another implementation", async () => {
    let implementation = "claude-code";
    const d = { ...deps(), implementationOf: () => implementation };
    const agents = new AgentsManager(d).scoped(args());
    const first = await agents.session(opus);
    implementation = "@acme/impostor";
    await expect(
      agents.session(reviewer, { session: first.ref })
    ).rejects.toMatchObject({ code: "SESSION_ROUTE_CONFLICT" });
  });

  it("completes a legacy ref only from what its messages recorded", async () => {
    const d = deps();
    const agents = new AgentsManager(d).scoped(args());
    const first = await agents.session(opus);
    await first.generate("Look.");
    const legacy = { id: first.ref.id };
    const resumed = await agents.session(reviewer, { session: legacy });
    expect(resumed.ref).toMatchObject({
      model: "opus",
      provider: "claude-code",
    });

    const written = new Sessions({ store: d.sessions });
    const silent = await written.createSession({ id: "silent" });
    await written.appendMessage({
      parts: [{ text: "hi", type: "text" }],
      role: "user",
      sessionId: silent.id,
    });
    await expect(
      agents.session(reviewer, { session: { id: "silent" } })
    ).rejects.toMatchObject({ code: "SESSION_ROUTE_UNRECOVERABLE" });
  });
});
