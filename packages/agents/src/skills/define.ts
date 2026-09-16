import { parseFrontmatter } from "./frontmatter";
import type { Skill, SkillFile } from "./types";

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
export function defineSkill(source: SkillSource): Skill {
  const { data, body } = parseFrontmatter(source.manifest);
  const instructions = body.trim();

  const files = Object.fromEntries(
    Object.entries(source.files ?? {}).filter(([path]) => path !== "SKILL.md")
  );

  const parsedName = data.name?.trim() ?? "";

  return {
    description: data.description?.trim() ?? "",
    name: parsedName.length > 0 ? parsedName : (source.fallbackName ?? ""),
    ...(instructions ? { instructions } : {}),
    ...(Object.keys(files).length > 0 ? { files } : {}),
  };
}
