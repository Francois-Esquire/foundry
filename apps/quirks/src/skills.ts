import { readdir, readFile } from "node:fs/promises";
import { basename, join } from "node:path";

import type { Skill, SkillFile } from "@foundry/agents/skills";

import { defineSkill } from "@foundry/agents/skills";

/**
 * Reading `<workspace>/skills/` off disk. `@foundry/agents/skills`
 * deliberately never touches a filesystem, so every host keeps its own reader
 * (chat and Studio each have one); this is Quirks's.
 */

async function collectFiles(root: string): Promise<Record<string, SkillFile>> {
  const files: Record<string, SkillFile> = {};
  async function walk(dir: string, prefix: string): Promise<void> {
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (entry.name.startsWith(".") || entry.name === "node_modules") {
        continue;
      }
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        await walk(join(dir, entry.name), rel);
        continue;
      }
      const content = await readFile(join(dir, entry.name), "utf8").catch(
        () => null
      );
      if (content !== null) {
        files[rel] = content;
      }
    }
  }
  await walk(root, "");
  return files;
}

async function readSkillDir(dir: string): Promise<Skill | null> {
  const manifest = await readFile(join(dir, "SKILL.md"), "utf8").catch(
    () => null
  );
  if (manifest === null) {
    return null;
  }
  return defineSkill({
    fallbackName: basename(dir),
    files: await collectFiles(dir),
    manifest,
  });
}

/** Resolve catalog names to skills under `root`; a name with no directory is skipped. */
export async function skillsNamed(
  names: readonly string[],
  root: string
): Promise<Skill[]> {
  const read = await Promise.all(
    names.map((name) => readSkillDir(join(root, name)))
  );
  return read.filter((skill): skill is Skill => skill !== null);
}
