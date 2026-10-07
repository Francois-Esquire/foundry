import { createInMemoryAgentAuthorizer } from "@foundry/agents/authorization";
import type { SessionEvent } from "@foundry/agents/session";
import { InMemorySessionStore } from "@foundry/agents/session";
import { describe, expect, it } from "vitest";
import type { ManagerArgs } from "~/lib/bindings";
import { CLAUDE_CODE, CODEX } from "~/lib/harnesses";
import type { AgentsDeps } from "~/lib/managers/agents";
import { AgentsManager } from "~/lib/managers/agents";
import { mockModels } from "~/lib/models/echo";
import { RunScope } from "~/lib/run-scope";
import type { AgentDefinition } from "~/lib/types";
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
        },
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

  it("continues a session by reference and starts fresh on another provider", async () => {
    const warnings: string[] = [];
    const agents = new AgentsManager(deps(warnings)).scoped(args());
    const first = await agents.session(reviewer);
    const again = await agents.session(reviewer, { session: first.ref });
    expect(again.ref.id).toBe(first.ref.id);
    const viaSession = await agents.session(reviewer, { session: first });
    expect(viaSession.ref.id).toBe(first.ref.id);

    const moved = await agents.session(
      { ...reviewer, provider: "codex" },
      { session: first.ref }
    );
    expect(moved.ref.id).not.toBe(first.ref.id);
    expect(warnings).toEqual([
      `session ${first.ref.id} was opened on claude-code; starting a new session on codex`,
    ]);
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
