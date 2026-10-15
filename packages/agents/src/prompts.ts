import type { ReferenceKind, ReferenceSource } from "@foundry/core/agents";
import type { AgentRegistry } from "./agents/registry";
import type { SkillRegistry } from "./skills/types";

/**
 * The registries a catalog can be composed from. Each is read live
 * on every lookup, so a skill added between turns resolves on the next
 * check. Only the lookup method of each is required.
 */
export interface CatalogRegistries {
  readonly agents?: Pick<AgentRegistry, "getPreset">;
  readonly skills?: Pick<SkillRegistry, "get">;
}

/**
 * The catalog of what this package knows, as one reference source: agent
 * presets answer for `agent` references and skills for `skill` references.
 * Add it to a `prompts` beside other sources
 * (`prompts.add(createCatalog(registries))`) to validate across everything a
 * host has; `prompts.remove(catalog)` takes it back out. A registry left out leaves its kind uncovered,
 * and an uncovered kind is not validated.
 */
export function createCatalog(registries: CatalogRegistries): ReferenceSource {
  const lookups = new Map<ReferenceKind, (name: string) => boolean>();
  const { agents, skills } = registries;
  if (agents !== undefined) {
    lookups.set("agent", (name) => agents.getPreset(name) !== undefined);
  }
  if (skills !== undefined) {
    lookups.set("skill", (name) => skills.get(name) !== undefined);
  }
  return {
    covers: (kind) => lookups.has(kind),
    has: (kind, name) => lookups.get(kind)?.(name) ?? false,
  };
}
