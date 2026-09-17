import { describe, expect, it, vi } from "vitest";

import type { AgentEntry } from "../../agents/registry";
import { createAgentRegistry, resolveAgentEntry } from "../../agents/registry";
import type { AgentPreset } from "../../agents/resolve";
import type { AgentHarness, SessionHarness } from "../../harness";

const ALREADY_REGISTERED_AT_GENERATION_1_PATTERN =
  /already registered at generation 1/;
const RAW_ACCESS_REQUIRES_REGISTRY_COMPATIBILITY_PATTERN =
  /raw access requires registry\.compatibility/;
const CURRENT_GENERATION_IS_42_PATTERN = /current generation is 42/;
const CURRENT_GENERATION_IS_42_PATTERN_2 = /current generation is 42/;

function retainedPreset(
  id: string,
  reply: string
): {
  preset: AgentPreset;
  createAgent: ReturnType<typeof vi.fn>;
  createSession: ReturnType<typeof vi.fn>;
} {
  const agent = {
    stream: vi.fn(() => ({ text: Promise.resolve(reply) })),
  } as unknown as AgentEntry;
  const createAgent = vi.fn(() =>
    Promise.resolve({ agent } as unknown as AgentHarness)
  );
  const createSession = vi.fn(() =>
    Promise.resolve({ agent } as unknown as SessionHarness)
  );
  return {
    createAgent,
    createSession,
    preset: {
      createAgent,
      createSession,
      spec: { id, prompt: `${reply} prompt` },
    },
  };
}

describe("AgentPreset catalog", () => {
  it("keeps one retained definition discoverable through direct, Session, and named projections", async () => {
    const registry = createAgentRegistry();
    const definition = retainedPreset("researcher", "generation one");

    registry.registerPreset({
      generation: 1,
      id: "researcher",
      preset: definition.preset,
    });

    const direct = registry.getPreset("researcher");
    const [listed] = registry.listPresets();
    expect(direct).toEqual(listed);
    expect(direct?.preset).toBe(definition.preset);
    expect(direct?.preset.spec.id).toBe("researcher");
    expect((await direct?.preset.createAgent({}))?.agent).toBeDefined();
    expect((await direct?.preset.createSession({}))?.agent).toBeDefined();

    const projected = resolveAgentEntry("researcher", registry.compatibility);
    expect(definition.createAgent).toHaveBeenCalledTimes(1);
    const result = await projected.stream({ prompt: "go" });
    expect(await result.text).toBe("generation one");
    expect(definition.createAgent).toHaveBeenCalledTimes(2);
    expect(definition.createSession).toHaveBeenCalledTimes(1);
  });

  it("rejects duplicates and makes raw/preset access explicit", () => {
    const registry = createAgentRegistry();
    const definition = retainedPreset("researcher", "one");
    registry.registerPreset({
      generation: 1,
      id: "researcher",
      preset: definition.preset,
    });

    expect(() => {
      registry.registerPreset({
        generation: 2,
        id: "researcher",
        preset: definition.preset,
      });
    }).toThrow(ALREADY_REGISTERED_AT_GENERATION_1_PATTERN);
    expect(() =>
      resolveAgentEntry(
        "researcher",
        registry as unknown as Parameters<typeof resolveAgentEntry>[1]
      )
    ).toThrow(RAW_ACCESS_REQUIRES_REGISTRY_COMPATIBILITY_PATTERN);
    expect(registry).not.toHaveProperty("register");
    expect(registry).not.toHaveProperty("get");
    expect(registry).not.toHaveProperty("list");
  });

  it("publishes, atomically replaces, generation-pins, and withdraws an opaque namespaced id", async () => {
    const registry = createAgentRegistry();
    const id =
      "installation:install-7/release:release-3/export:research-assistant";
    const first = retainedPreset(id, "generation one");
    const second = retainedPreset(id, "generation two");

    registry.registerPreset({ generation: 41, id, preset: first.preset });
    const pinned = resolveAgentEntry(id, registry.compatibility);

    registry.replacePreset(
      { generation: 41, id },
      { generation: 42, id, preset: second.preset }
    );
    const current = resolveAgentEntry(id, registry.compatibility);

    expect(await (await pinned.stream({ prompt: "go" })).text).toBe(
      "generation one"
    );
    expect(await (await current.stream({ prompt: "go" })).text).toBe(
      "generation two"
    );
    expect(registry.getPreset(id)?.generation).toBe(42);
    expect(() => {
      registry.replacePreset(
        { generation: 41, id },
        { generation: 43, id, preset: second.preset }
      );
    }).toThrow(CURRENT_GENERATION_IS_42_PATTERN);
    expect(() => {
      registry.withdrawPreset({ generation: 41, id });
    }).toThrow(CURRENT_GENERATION_IS_42_PATTERN_2);
    expect(registry.withdrawPreset({ generation: 42, id })).toBe(true);
    expect(registry.getPreset(id)).toBeUndefined();
    expect(registry.compatibility.has(id)).toBe(false);
  });
});
