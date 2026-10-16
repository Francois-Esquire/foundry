import {
  type ReferenceKind,
  type ReferenceSource,
  referenceSource,
} from "@foundry/core/agents";
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
export function createCatalog({
  agents,
  skills,
}: CatalogRegistries): ReferenceSource {
  return referenceSource<ReferenceKind>({
    agent: agents && ((name) => agents.getPreset(name) !== undefined),
    skill: skills && ((name) => skills.get(name) !== undefined),
  });
}
