import type { ToolSet } from "ai";

import { tool } from "ai";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { createMesh } from "../../agents/mesh";
import type { AgentModel } from "../../agents/model";
import { createAgentRegistry } from "../../agents/registry";
import type { AgentSurface } from "../../agents/resolve";
import { createAgentPreset, resolveAgent } from "../../agents/resolve";
import type { AgentSpec } from "../../agents/spec";
import type {
  AgentAuthorizationRequest,
  AgentAuthorizer,
} from "../../authorization";
import { AgentHarness, SessionHarness, tagTool } from "../../harness";
import { InMemorySessionStore } from "../../session";
import type { Skill } from "../../skills";
import { fakeAuthorizer } from "../helpers/authorizer";
import {
  createScriptedMockModel,
  textGenerateResult,
  toolCallGenerateResult,
  usageStreamResult,
} from "../helpers/mock-language-model";

/** The surface's model resolver: one streamed reply per constructed harness. */
function fakeModel(): AgentModel {
  return createScriptedMockModel({ stream: [usageStreamResult("ok", 1, 0)] });
}

/** A model that scripts one tool call, then stops — fresh scripted responses
 *  per resolution, so each constructed harness gets its own independent queue. */
function toolCallModel(): AgentModel {
  return createScriptedMockModel({
    generate: [
      toolCallGenerateResult("call-1", "probe", {}),
      textGenerateResult("done"),
    ],
  });
}

const skill = (name: string): Skill => ({
  description: `${name} skill`,
  instructions: `Do ${name}.`,
  name,
});

/** An authorizer that records every request it decides, always allowing it. */
function trackingPolicy(
  requests: AgentAuthorizationRequest[]
): AgentAuthorizer {
  return fakeAuthorizer((request) => {
    requests.push(request);
    return { kind: "allow", source: "global-policy" };
  });
}

/** A harmless declared tool whose capability derivation carries nothing
 *  fixture-specific — used only to force a policy check per generated turn. */
function probeTools(): ToolSet {
  return {
    probe: tool({
      description: "probe",
      execute: () => "ok",
      inputSchema: z.object({}),
    }),
  };
}

describe("resolveAgent", () => {
  it("provisions a harness, resolves skills + mcp, and joins the mesh", async () => {
    const skills = vi.fn((names: string[]) =>
      Promise.resolve(names.map(skill))
    );
    const mcp = vi.fn(() => Promise.resolve({}));
    const mesh = createMesh();
    const surface: AgentSurface = {
      mcp,
      mesh,
      model: fakeModel,
      skills,
      store: new InMemorySessionStore(),
    };
    const spec: AgentSpec = {
      id: "researcher",
      mcp: ["context7"],
      mesh: { join: true },
      prompt: "Research thoroughly.",
      role: "Researcher",
      skills: ["architect"],
    };

    const harness = await resolveAgent(spec, surface);

    expect(harness).toBeInstanceOf(SessionHarness);
    expect(skills).toHaveBeenCalledWith(["architect"]);
    expect(mcp).toHaveBeenCalledWith(["context7"]);
    expect(mesh.has("researcher")).toBe(true);
    expect(mesh.get("researcher")?.role).toBe("Researcher");
  });

  it("runs off-bus and skips resolvers when the spec declares none", async () => {
    const skills = vi.fn((names: string[]) =>
      Promise.resolve(names.map(skill))
    );
    const mesh = createMesh();
    const surface: AgentSurface = {
      mesh,
      model: fakeModel,
      skills,
    };
    const spec: AgentSpec = { id: "loner", prompt: "Work alone." };

    const harness = await resolveAgent(spec, surface);

    expect(harness).toBeInstanceOf(SessionHarness);
    expect(skills).not.toHaveBeenCalled();
    expect(mesh.list()).toHaveLength(0);
  });
});

describe("createAgentPreset", () => {
  it("keeps file-defined MCP registration identity through provisioning", async () => {
    const requests: AgentAuthorizationRequest[] = [];
    const policy = trackingPolicy(requests);
    const mcp = vi.fn((ids: string[]) => {
      const serverId = ids[0];
      if (!serverId) {
        throw new Error("missing MCP server id");
      }
      const { probe } = probeTools();
      if (!probe) {
        throw new Error("missing probe tool");
      }
      return Promise.resolve({
        probe: tagTool(probe, {
          capability: () => ({
            kind: "mcp.tool" as const,
            serverId,
            tool: "probe",
          }),
          source: "mcp",
        }),
      });
    });
    const preset = createAgentPreset(
      {
        id: "file-agent",
        mcp: ["context7"],
        prompt: "Use the configured server.",
      },
      { mcp, model: toolCallModel }
    );

    const harness = await preset.createAgent({ policy });
    await harness.generate({ prompt: "go" });

    expect(mcp).toHaveBeenCalledWith(["context7"]);
    expect(requests.map((request) => request.capability)).toContainEqual({
      kind: "mcp.tool",
      serverId: "context7",
      tool: "probe",
    });
  });

  it("createAgent and createSession share base tools, policy, prompt, and model; createSession adds store + mesh", async () => {
    const requests: AgentAuthorizationRequest[] = [];
    const policy = trackingPolicy(requests);
    const store = new InMemorySessionStore();
    const mesh = createMesh();
    const surface: AgentSurface = {
      mesh,
      model: toolCallModel,
      store,
    };
    const spec: AgentSpec = {
      id: "researcher",
      mesh: { join: true },
      prompt: "Research thoroughly.",
    };
    const preset = createAgentPreset(spec, surface);

    const direct = await preset.createAgent({
      policy,
      tools: probeTools(),
    });
    const session = await preset.createSession({
      policy,
      sessionId: "s1",
      tools: probeTools(),
    });

    expect(direct).toBeInstanceOf(AgentHarness);
    expect(direct).not.toBeInstanceOf(SessionHarness);
    expect(session).toBeInstanceOf(SessionHarness);

    // Same base tool set on both (the todo built-in + the shared tool; the
    // spec names no skills, so no skill tools) — the Session variant adds only
    // the mesh tools it alone owns.
    const baseToolNames = ["probe", "todo"];
    expect(Object.keys(direct.agent.tools).sort()).toEqual(baseToolNames);
    expect(Object.keys(session.agent.tools).sort()).toEqual(
      [...baseToolNames, "list_agents", "message_agent"].sort()
    );

    // Session-only additions: store + mesh join.
    expect(session.store).toBe(store);
    expect(mesh.has("researcher")).toBe(true);

    // Exercising both compiled `probe` tools proves the SAME policy (not a
    // duplicate) gates both variants, and both report the preset's real
    // agent identity — never a generic placeholder.
    await direct.generate({ prompt: "go" });
    await session.generate("go");

    expect(requests.length).toBeGreaterThan(0);
    expect(requests.every((r) => r.subject.id === "researcher")).toBe(true);
  });

  it("preset identity survives reconstruction and never falls back to a different agent", async () => {
    const requests: AgentAuthorizationRequest[] = [];
    const policy = trackingPolicy(requests);
    const surface: AgentSurface = { model: toolCallModel };
    const spec: AgentSpec = { id: "alpha", prompt: "Be alpha." };
    const preset = createAgentPreset(spec, surface);

    const first = await preset.createAgent({
      policy,
      tools: probeTools(),
    });
    const second = await preset.createAgent({
      policy,
      tools: probeTools(),
    });
    const third = await preset.createSession({
      policy,
      sessionId: "s2",
      tools: probeTools(),
    });

    await first.generate({ prompt: "go" });
    await second.generate({ prompt: "go" });
    await third.generate("go");

    expect(preset.spec).toBe(spec);
    expect(preset.spec.id).toBe("alpha");
    expect(requests.length).toBeGreaterThan(0);
    expect(requests.every((r) => r.subject.id === "alpha")).toBe(true);
  });

  it("resolves the spec's model id through the surface unless the context hands in a model", async () => {
    const resolved: (string | undefined)[] = [];
    const surface: AgentSurface = {
      model: (id) => {
        resolved.push(id);
        return toolCallModel();
      },
    };
    const preset = createAgentPreset(
      { id: "confined", model: "spec/model", prompt: "Stay put." },
      surface
    );

    const fromSpec = await preset.createSession({ sessionId: "s1" });
    expect(resolved).toEqual(["spec/model"]);
    expect(fromSpec.model).toBeDefined();

    const own = toolCallModel();
    const fromContext = await preset.createSession({
      model: own,
      sessionId: "s2",
    });
    expect(resolved).toEqual(["spec/model"]);
    expect(fromContext.model).toBe(own);
  });

  it("forwards createSession's surfaceContext opaquely, with no effect at this layer", async () => {
    const policy = trackingPolicy([]);
    const surface: AgentSurface = { model: toolCallModel };
    const spec: AgentSpec = {
      id: "researcher",
      prompt: "Research thoroughly.",
    };
    const preset = createAgentPreset(spec, surface);

    const plain = await preset.createSession({ policy, sessionId: "s1" });
    const withContext = await preset.createSession({
      policy,
      sessionId: "s2",
      surfaceContext: { roadmapId: "r1" },
    });

    // `resolve.ts` forwards `surfaceContext` opaquely -- it neither validates
    // it nor merges it into a harness's tool context. A concrete preset (e.g.
    // Studio's Planning preset) is the one that reads it and decides what to
    // fold into its own tool context.
    expect(Object.keys(withContext.agent.tools).sort()).toEqual(
      Object.keys(plain.agent.tools).sort()
    );
    await expect(withContext.generate("go")).resolves.toBeDefined();
  });
});

describe("AgentRegistry preset storage", () => {
  it("retains one canonical preset entry and exposes its named compatibility projection", () => {
    const surface: AgentSurface = { model: fakeModel };
    const spec: AgentSpec = { id: "researcher", prompt: "Research." };
    const preset = createAgentPreset(spec, surface);
    const registry = createAgentRegistry();

    registry.registerPreset({ generation: 1, id: "researcher", preset });

    expect(registry.getPreset("researcher")).toEqual({
      generation: 1,
      id: "researcher",
      preset,
    });
    expect(registry.listPresets()).toEqual([
      { generation: 1, id: "researcher", preset },
    ]);
    expect(registry.compatibility.has("researcher")).toBe(true);
    expect(registry.compatibility.list()).toEqual(["researcher"]);
  });
});
