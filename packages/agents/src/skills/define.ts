import {
  type Referenceable,
  type Skill,
  type SkillFile,
  withReference,
} from "@foundry/core/agents";
import { parseFrontmatter } from "./frontmatter";

export interface SkillSource {
  fallbackName?: string;
  files?: Record<string, SkillFile>;
  manifest: string;
}

export function defineSkill(
  source: SkillSource
): Skill & Referenceable<"skill"> {
  const { data, body } = parseFrontmatter(source.manifest);
  const instructions = body.trim();

  const files = Object.fromEntries(
    Object.entries(source.files ?? {}).filter(([path]) => path !== "SKILL.md")
  );

  const parsedName = data.name?.trim() ?? "";

  return referenceable({
    description: data.description?.trim() ?? "",
    name: parsedName.length > 0 ? parsedName : (source.fallbackName ?? ""),
    ...(instructions ? { instructions } : {}),
    ...(Object.keys(files).length > 0 ? { files } : {}),
  });
}

function referenceable(skill: Skill): Skill & Referenceable<"skill"> {
  return withReference(skill, () => ({ kind: "skill", name: skill.name }));
}
