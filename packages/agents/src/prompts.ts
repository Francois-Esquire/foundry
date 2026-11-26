import {
  type ReferenceKind,
  type ReferenceSource,
  referenceSource,
} from "@foundry/core/agents";
import type { AgentRegistry } from "./agents/registry";
import type { SkillRegistry } from "./skills/registry";

export interface CatalogRegistries {
  readonly agents?: Pick<AgentRegistry, "getPreset">;
  readonly skills?: Pick<SkillRegistry, "get">;
}

export function createCatalog({
  agents,
  skills,
}: CatalogRegistries): ReferenceSource {
  return referenceSource<ReferenceKind>({
    agent: agents && ((name) => agents.getPreset(name) !== undefined),
    skill: skills && ((name) => skills.get(name) !== undefined),
  });
}
