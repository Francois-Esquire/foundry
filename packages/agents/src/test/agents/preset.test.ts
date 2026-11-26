import type { AgentModel } from "@foundry/core/agents";
import type { ToolSet } from "ai";
import { tool } from "ai";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import type { AgentSpec, AgentSurface } from "../../agents/preset";
import { createAgentPreset, resolveAgent } from "../../agents/preset";
import type {
  AgentAuthorizationRequest,
  AgentAuthorizer,
} from "../../authorization/authorization";
import { AgentHarness } from "../../harness/agent-harness";
import { SessionHarness } from "../../harness/session-harness";
import { tagTool } from "../../harness/tool-registration";
import type { Skill } from "../../skills/registry";
import { MemorySessionStore } from "../../store/memory";
import { fakeAuthorizer } from "../helpers/authorizer";
import {
  createScriptedMockModel,
  textGenerateResult,
  textStreamResult,
  toolCallGenerateResult,
  toolCallStreamResult,
  usageStreamResult,
} from "../helpers/mock-language-model";
import { recordingStore } from "../helpers/recording-store";

function fakeModel(): AgentModel {
  return createScriptedMockModel({ stream: [usageStreamResult("ok", 1, 0)] });
}

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

function trackingPolicy(
  requests: AgentAuthorizationRequest[]
): AgentAuthorizer {
  return fakeAuthorizer((request) => {
    requests.push(request);
    return { kind: "allow", source: "global-policy" };
  });
}

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
  it("provisions a Session harness with the declared skills and MCP servers", async () => {
    const skills = vi.fn((names: string[]) =>
      Promise.resolve(names.map(skill))
    );
    const mcp = vi.fn(() => Promise.resolve({}));
    const surface: AgentSurface = {
      mcp,
      model: fakeModel,
      skills,
      store: new MemorySessionStore(),
    };

    const harness = await resolveAgent(
      {
        id: "researcher",
        mcp: ["context7"],
        prompt: "Research thoroughly.",
        skills: ["architect"],
      },
      surface
    );

    expect(harness).toBeInstanceOf(SessionHarness);
    expect(skills).toHaveBeenCalledWith(["architect"]);
    expect(mcp).toHaveBeenCalledWith(["context7"]);
  });

  it("adds no tools to a spec that declares none", async () => {
    const skills = vi.fn((names: string[]) =>
      Promise.resolve(names.map(skill))
    );
    const preset = createAgentPreset(
      { id: "loner", prompt: "Work alone." },
      { model: fakeModel, skills }
    );

    const direct = await preset.createAgent({});
    const session = await preset.createSession({});

    expect(Object.keys(direct.agent.tools)).toEqual([]);
    expect(Object.keys(session.agent.tools)).toEqual([]);
    expect(skills).not.toHaveBeenCalled();
  });
});

describe("createAgentPreset", () => {
  it.each([false, true])(
    "retains one-off Session correlation without creating history, factory: %s",
    async (factory) => {
      const requests: AgentAuthorizationRequest[] = [];
      const { store, writes } = recordingStore(new MemorySessionStore());
      const observe = vi.fn(() => null);
      const spec: AgentSpec = { id: "correlated", prompt: "Work once." };
      const preset = createAgentPreset(
        spec,
        factory
          ? () => ({ model: toolCallModel(), observe, store })
          : { model: toolCallModel, observe, store }
      );
      const harness = await preset.createAgent({
        policy: trackingPolicy(requests),
        sessionId: "existing-session",
        tools: probeTools(),
      });
      await harness.generate({ prompt: "go" });
      expect(observe).toHaveBeenCalledWith(
        expect.objectContaining({ sessionId: "existing-session" })
      );
      expect(requests[0]).toMatchObject({ scopeId: "existing-session" });
      expect(writes).toEqual([]);
    }
  );

  it("applies configured generation settings and invocation overrides in both harnesses", async () => {
    const model = createScriptedMockModel({
      generate: [textGenerateResult("direct")],
      stream: [textStreamResult("session")],
    });
    const generate = vi.spyOn(model, "doGenerate");
    const stream = vi.spyOn(model, "doStream");
    const preset = createAgentPreset(
      {
        id: "settings",
        prompt: "Configured prompt",
        settings: { maxOutputTokens: 42, temperature: 0.2 },
      },
      (context) => ({
        instructions: context.instructions,
        model,
        temperature: 0.1,
      })
    );
    const direct = await preset.createAgent({ settings: { temperature: 0.3 } });
    await direct.generate({ prompt: "go" });
    const session = await preset.createSession({
      settings: { temperature: 0.4 },
    });
    await session.generate("go");
    expect(generate.mock.calls[0]?.[0]).toMatchObject({
      maxOutputTokens: 42,
      temperature: 0.3,
    });
    expect(stream.mock.calls[0]?.[0]).toMatchObject({
      maxOutputTokens: 42,
      temperature: 0.4,
    });
    expect(generate.mock.calls[0]?.[0].prompt).toContainEqual({
      content: "Configured prompt",
      role: "system",
    });
    expect(stream.mock.calls[0]?.[0].prompt).toContainEqual({
      content: "Configured prompt",
      role: "system",
    });
  });

  it.each([false, true])(
    "retains factory Session defaults and applies invocation overrides: %s",
    async (override) => {
      const store = new MemorySessionStore();
      const overrideStore = new MemorySessionStore();
      const observe = vi.fn(() => null);
      const preset = createAgentPreset(
        { id: "configured", prompt: "" },
        () => ({
          model: fakeModel(),
          observe,
          sessionId: "default-session",
          store,
        })
      );
      const harness = await preset.createSession(
        override
          ? {
              sessionId: "invoked-session",
              sessionStore: overrideStore,
            }
          : {}
      );
      const expectedStore = override ? overrideStore : store;
      const sessionId = override ? "invoked-session" : "default-session";
      expect(harness.store).toBe(expectedStore);
      expect(harness.sessionId).toBe(sessionId);
      await harness.generate("go");
      expect(await expectedStore.getSession(sessionId)).toBeTruthy();
      expect(observe).toHaveBeenCalledWith(
        expect.objectContaining({ sessionId })
      );
    }
  );

  it.each([true, false])(
    "resolves Session compaction settings, enabled: %s",
    async (enabled) => {
      const store = new MemorySessionStore();
      const summarize = vi.fn(() => Promise.resolve("RECAP"));
      const preset = createAgentPreset(
        {
          id: "compaction",
          prompt: "",
          session: { compaction: { keepTokens: 1 } },
        },
        () => ({
          compaction: {
            model: { contextWindow: 100, id: "small" },
            summarizer: { summarize },
            window: {
              highWaterRatio: 1,
              reservedOutput: 0,
              safetyMarginRatio: 0,
            },
          },
          model: createScriptedMockModel({
            stream: [
              usageStreamResult("first", 200, 0),
              usageStreamResult("second", 0, 0),
            ],
          }),
          store,
        })
      );
      const session = await preset.createSession(
        enabled ? {} : { compaction: false }
      );
      await session.generate("first");
      await session.generate("second");
      expect(summarize).toHaveBeenCalledTimes(enabled ? 1 : 0);
    }
  );

  it("resolves selected domain tools and rejects missing or duplicate bindings", async () => {
    const tools = vi.fn(() => Promise.resolve(probeTools()));
    const preset = createAgentPreset(
      { id: "configured", prompt: "Use the domain.", tools: ["probe"] },
      { model: toolCallModel, tools }
    );
    const direct = await preset.createAgent({
      surfaceContext: { artifactId: "a" },
    });
    await direct.generate({ prompt: "go" });
    const session = await preset.createSession({ sessionId: "s" });
    await session.generate("go");
    expect(tools).toHaveBeenCalledWith(["probe"], {
      surfaceContext: { artifactId: "a" },
    });
    await expect(preset.createAgent({ tools: probeTools() })).rejects.toThrow(
      "Duplicate tool binding: probe"
    );
    await expect(
      createAgentPreset(
        { id: "missing", prompt: "", tools: ["unknown"] },
        { model: fakeModel, tools }
      ).createAgent({})
    ).rejects.toThrow('no binding for tool "unknown"');
    await expect(
      createAgentPreset(
        { id: "missing", prompt: "", tools: ["probe"] },
        { model: fakeModel }
      ).createAgent({})
    ).rejects.toThrow("no tool resolver");
  });

  it("binds domain context in both harnesses without constructing a Session for an operation", async () => {
    const { store, writes } = recordingStore(new MemorySessionStore());
    const filed = () =>
      writes.filter(
        (write) =>
          write.putSessions !== undefined && write.putMessages === undefined
      );
    const seen: unknown[] = [];
    const preset = createAgentPreset(
      { id: "domain", prompt: "Shared instructions" },
      (context, spec) => ({
        instructions: spec.prompt,
        model: createScriptedMockModel({
          generate: [
            toolCallGenerateResult("direct", "probe", {}),
            textGenerateResult("done"),
          ],
          stream: [
            toolCallStreamResult("session", "probe", {}),
            textStreamResult("done"),
          ],
        }),
        store,
        tools: {
          probe: tool({
            description: "Read bound context",
            execute: (_input, options) => {
              seen.push(options.context);
              return "ok";
            },
            inputSchema: z.object({}),
          }),
        },
        toolsContext: {
          db: "bound-db",
          ...context.surfaceContext,
          execution: context.execution,
        },
      })
    );
    const execution = { runId: "run", signal: new AbortController().signal };
    const direct = await preset.createAgent({
      execution,
      surfaceContext: { artifactId: "a" },
    });
    await direct.generate({ prompt: "go" });
    expect(writes).toEqual([]);
    const session = await preset.createSession({
      execution,
      surfaceContext: { artifactId: "b" },
    });
    await session.generate("go");
    expect(filed()).toHaveLength(1);
    expect(seen).toEqual([
      expect.objectContaining({ artifactId: "a", db: "bound-db", execution }),
      expect.objectContaining({ artifactId: "b", db: "bound-db", execution }),
    ]);
  });

  it("keeps file-defined MCP registration identity through provisioning", async () => {
    const requests: AgentAuthorizationRequest[] = [];
    const policy = trackingPolicy(requests);
    const mcp = vi.fn((ids: string[]) => {
      const [serverId] = ids;
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

  it.each([false, true])(
    "retains context overrides and the resolved Session identity, domain callback: %s",
    async (callback) => {
      const store = new MemorySessionStore();
      const contexts: unknown[] = [];
      const model = createScriptedMockModel({
        stream: [
          toolCallStreamResult("probe-1", "probe", {}),
          textStreamResult("done"),
        ],
      });
      const settings = {
        model,
        store,
        tools: {
          probe: tool({
            execute: (_input, options) => {
              contexts.push(options.context);
              return "ok";
            },
            inputSchema: z.object({}),
          }),
        },
        toolsContext: { db: "database", setting: "default" },
      };
      const preset = createAgentPreset(
        { id: "context", prompt: "" },
        callback
          ? () => ({
              ...settings,
              toolsContext: {
                ...settings.toolsContext,
                artifactId: "artifact",
              },
            })
          : {
              ...settings,
              model: () => model,
              tools: () => Promise.resolve(settings.tools),
            }
      );
      const execution = { runId: "run", signal: new AbortController().signal };
      const harness = await preset.createSession({
        execution,
        tools: callback ? undefined : settings.tools,
        toolsContext: { setting: "invocation" },
      });
      await harness.generate("go");
      expect(contexts[0]).toMatchObject({
        db: "database",
        execution,
        sessionId: expect.any(String) as unknown,
        setting: "invocation",
      });
      const context = contexts[0] as { sessionId: string };
      expect(context.sessionId).toBe(harness.sessionId);
      expect(await store.getSession(context.sessionId)).toBeTruthy();
      if (callback) {
        expect(contexts[0]).toHaveProperty("artifactId", "artifact");
      }
    }
  );

  it("createAgent and createSession share base tools, policy, prompt, and model; createSession adds the store", async () => {
    const requests: AgentAuthorizationRequest[] = [];
    const policy = trackingPolicy(requests);
    const store = new MemorySessionStore();
    const surface: AgentSurface = {
      model: toolCallModel,
      store,
    };
    const spec: AgentSpec = {
      id: "researcher",
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

    expect(Object.keys(direct.agent.tools)).toEqual(["probe"]);
    expect(Object.keys(session.agent.tools)).toEqual(["probe"]);

    expect(session.store).toBe(store);

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
      model: ({ model: id }) => {
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

  it("keeps the host's policy and model when spec settings carry those keys", async () => {
    const policy = trackingPolicy([]);
    const model = toolCallModel();
    const surface: AgentSurface = { model: () => model, policy };
    const settings = {
      model: null,
      policy: null,
    } as unknown as AgentSpec["settings"];
    const preset = createAgentPreset(
      { id: "kept", prompt: "Hold.", settings },
      surface
    );

    const agent = await preset.createAgent({ tools: probeTools() });
    expect(agent.policy).toBe(policy);
    expect(agent.model).toBe(model);
    await agent.generate({ prompt: "go" });
    const session = await preset.createSession({ sessionId: "s1" });
    expect(session.policy).toBe(policy);
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

    expect(Object.keys(withContext.agent.tools).sort()).toEqual(
      Object.keys(plain.agent.tools).sort()
    );
    await expect(withContext.generate("go")).resolves.toBeDefined();
  });
});
