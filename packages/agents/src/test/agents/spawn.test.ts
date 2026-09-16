import type { UIMessageChunk } from "ai";

import { simulateReadableStream } from "ai";
import { describe, expect, it } from "vitest";

import type { AgentEntry } from "../../agents/registry";
import { createAgentCompatibilityRegistry } from "../../agents/registry";
import type { RunAgent, SpawnDeps } from "../../agents/spawn";
import { createSpawnTool } from "../../agents/spawn";
import { InMemorySessionStore } from "../../session/store";

function uiTextRun(...texts: string[]) {
  const chunks: UIMessageChunk[] = texts.flatMap((t, i) => [
    { id: `t${i}`, type: "text-start" },
    { delta: t, id: `t${i}`, type: "text-delta" },
    { id: `t${i}`, type: "text-end" },
  ]);
  return {
    toUIMessageStream: () => simulateReadableStream({ chunks }),
  } as unknown as Awaited<ReturnType<RunAgent>>;
}

describe("createSpawnTool", () => {
  it("case 1: foreground spawn mints a linked, depth-frozen child and returns only the collapsed artifact", async () => {
    const store = new InMemorySessionStore();
    const parent = await store.createSession();
    const registry = createAgentCompatibilityRegistry();
    const stubAgent = {} as unknown as AgentEntry;
    registry.register("worker", stubAgent);

    let captured: Parameters<RunAgent>[1] | undefined;
    const runAgent: RunAgent = (_agent, opts) => {
      captured = opts;
      return Promise.resolve(uiTextRun("interim", "final answer"));
    };

    const deps: SpawnDeps = {
      depthLimit: 2,
      parentSession: parent,
      registry,
      runAgent,
      store,
    };
    const spawnTool = createSpawnTool(deps);
    if (!spawnTool?.execute) {
      throw new Error("expected a spawn tool");
    }

    const result = await spawnTool.execute(
      { agentKind: "worker", prompt: "do the thing" },
      { context: {}, messages: [], toolCallId: "t1" }
    );

    expect(result).toEqual({
      artifact: "final answer",
      mode: "foreground",
      ok: true,
    });
    expect(captured?.session.parentSessionId).toBe(parent.id);
    expect(captured?.session.recursionDepth).toBe(1);
    const persisted = await store.getSession(captured?.session.id ?? "");
    expect(persisted?.parentSessionId).toBe(parent.id);
    expect(persisted?.recursionDepth).toBe(1);
  });

  it("case 2: delegation prompt is the only parent→child channel", async () => {
    const store = new InMemorySessionStore();
    const parent = await store.createSession();
    const registry = createAgentCompatibilityRegistry();
    registry.register("worker", {} as unknown as AgentEntry);

    let captured: Parameters<RunAgent>[1] | undefined;
    const runAgent: RunAgent = (_agent, opts) => {
      captured = opts;
      return Promise.resolve(uiTextRun("final answer"));
    };

    const spawnTool = createSpawnTool({
      depthLimit: 2,
      parentSession: parent,
      registry,
      runAgent,
      store,
    });
    if (!spawnTool?.execute) {
      throw new Error("expected a spawn tool");
    }

    await spawnTool.execute(
      { agentKind: "worker", prompt: "do the thing" },
      { context: {}, messages: [], toolCallId: "t1" }
    );

    expect(captured?.prompt).toBe("do the thing");
    expect(captured?.session.id).not.toBe(parent.id);
  });

  it("case 3: unknown kind returns a modeled miss without throwing or minting a child", async () => {
    const store = new InMemorySessionStore();
    const parent = await store.createSession();
    const registry = createAgentCompatibilityRegistry();

    let captured: Parameters<RunAgent>[1] | undefined;
    const runAgent: RunAgent = (_agent, opts) => {
      captured = opts;
      return Promise.resolve(uiTextRun("final answer"));
    };

    const spawnTool = createSpawnTool({
      depthLimit: 2,
      parentSession: parent,
      registry,
      runAgent,
      store,
    });
    if (!spawnTool?.execute) {
      throw new Error("expected a spawn tool");
    }

    const result = await spawnTool.execute(
      { agentKind: "ghost", prompt: "do the thing" },
      { context: {}, messages: [], toolCallId: "t1" }
    );

    expect(result).toEqual({ ok: false, reason: "unknown-kind" });
    expect(captured).toBeUndefined();
  });

  it("case 4: withholds the tool at max depth", () => {
    const store = new InMemorySessionStore();
    const registry = createAgentCompatibilityRegistry();
    const runAgent: RunAgent = () => Promise.resolve(uiTextRun("final answer"));

    const atMax = createSpawnTool({
      depthLimit: 2,
      parentSession: {
        createdAt: 0,
        id: "p",
        recursionDepth: 2,
        status: "active",
        title: null,
        updatedAt: 0,
      },
      registry,
      runAgent,
      store,
    });
    expect(atMax).toBeUndefined();

    const underMax = createSpawnTool({
      depthLimit: 2,
      parentSession: {
        createdAt: 0,
        id: "p",
        recursionDepth: 1,
        status: "active",
        title: null,
        updatedAt: 0,
      },
      registry,
      runAgent,
      store,
    });
    expect(underMax).toBeDefined();
  });
});
