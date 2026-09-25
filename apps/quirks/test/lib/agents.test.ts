import { InMemorySessionStore } from "@foundry/agents/session";
import { afterEach, describe, expect, it } from "vitest";

import { CLAUDE_CODE, CODEX } from "~/harnesses";
import type { ManagerArgs } from "~/lib/bindings";
import { agentsManager } from "~/lib/managers/agents";
import { RunScope, runs } from "~/lib/run-scope";
import type { AgentDefinition } from "~/lib/types";
import { mockModels } from "~/models/echo";

afterEach(() => {
  runs.clear();
});

function args(): ManagerArgs & { readonly written: string[] } {
  const scope = new RunScope(`run-${Math.random()}`, "/tmp/project");
  const frame = scope.frame(["root", "review"]);
  const written: string[] = [];
  return {
    cwd: "/tmp/project",
    frame,
    scope,
    write: (value) => written.push(String(value)),
    written,
  };
}

function deps(warnings: string[] = []) {
  const models = mockModels(
    [CLAUDE_CODE, CODEX],
    ({ executor, prompt, cwd }) => `${executor.provider}@${cwd}: ${prompt}`
  );
  return {
    defaultExecutor: () => CLAUDE_CODE,
    models,
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
  it("opens a session on the default provider in the frame's directory and streams text", async () => {
    const a = args();
    const agents = agentsManager(deps())(a);
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

  it("honours provider and cwd overrides", async () => {
    const a = args();
    const agents = agentsManager(deps())(a);
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
    const agents = agentsManager(deps(warnings))(args());
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
    const agents = agentsManager(deps())(a);
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
    const agents = agentsManager(deps())(a);
    const session = await agents.session(reviewer);
    a.frame.controller.abort(new Error("step cancelled"));
    await expect(session.generate("hi")).rejects.toThrow("step cancelled");
  });
});
