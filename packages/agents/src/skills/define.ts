import {
  type Referenceable,
  type Skill,
  type SkillFile,
  withReference,
} from "@foundry/core/agents";
import { parseFrontmatter } from "./frontmatter";

/** The manifest and file tree a {@link Skill} is built from. */
export interface SkillSource {
  /**
   * Name to use when the manifest's frontmatter omits `name` — conventionally
   * the directory (or archive entry) the manifest came from.
   */
  fallbackName?: string;
  /**
   * Bundled files keyed by path relative to the skill root (e.g.
   * `"references/guide.md"`), each value the file's content. A `SKILL.md` key
   * is ignored: the manifest is surfaced as `instructions`, never as a file.
   */
  files?: Record<string, SkillFile>;
  /** Raw `SKILL.md` text — YAML frontmatter (`name`, `description`) over a markdown body. */
  manifest: string;
}

/**
 * Build a {@link Skill} from its manifest and bundled files. The frontmatter's
 * `name`/`description` win; the markdown body becomes `instructions`. Both
 * `instructions` and `files` are omitted entirely when empty, so a skill that
 * is nothing but frontmatter stays a valid, minimal `Skill`.
 */
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

/**
 * Let a skill stand in a prompt by value: `prompts.claude\`Use ${skill}\``
 * writes it in the dialect's notation, and a static tool resolves the
 * identifier instead of looking the name up. The method is not enumerable,
 * so the skill still compares and serializes as plain data.
 */
export function referenceable(skill: Skill): Skill & Referenceable<"skill"> {
  return withReference(skill, () => ({ kind: "skill", name: skill.name }));
}
