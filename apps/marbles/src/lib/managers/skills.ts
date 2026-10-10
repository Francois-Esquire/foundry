import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { basename, join, relative, resolve, sep } from "node:path";
import type { Skill, SkillFile } from "@foundry/agents/skills";
import { defineSkill } from "@foundry/agents/skills";
import { globToRegExp } from "@foundry/lib/glob";

import type { SkillOp, SkillSet } from "../types";

/**
 * Resolves a skill set recipe against the filesystem. `load` reads the
 * global and workspace skill directories, `add` walks a glob for directories
 * holding a `SKILL.md`, `pick` narrows by name. Resolution is cached per
 * recipe for the life of the resolver, which is one config load.
 */

export interface SkillRoots {
  /** Skills shared by every config on this machine. */
  readonly global: string;
  /** The config's directory; `load` reads its `skills/` folder. */
  readonly workspace: string;
}

const WORKSPACE_SKILLS_DIR = "skills";
const SKILL_MANIFEST = "SKILL.md";
const MAX_DEPTH = 8;
const SKIPPED = new Set(["node_modules", ".git"]);
const DOT_SLASH = /^\.\//;
const GLOB_SEGMENT = /[*?{[]/;

const STRICT_UTF8 = new TextDecoder("utf-8", { fatal: true });

/** Text stays text; anything that is not UTF-8 stays bytes, unmangled. */
function asSkillFile(bytes: Uint8Array): SkillFile {
  try {
    return STRICT_UTF8.decode(bytes);
  } catch {
    return bytes;
  }
}

async function collectFiles(root: string): Promise<Record<string, SkillFile>> {
  const files: Record<string, SkillFile> = {};
  async function walk(dir: string, prefix: string): Promise<void> {
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (entry.name.startsWith(".") || SKIPPED.has(entry.name)) {
        continue;
      }
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        await walk(join(dir, entry.name), rel);
        continue;
      }
      const bytes = await readFile(join(dir, entry.name)).catch(() => null);
      if (bytes !== null) {
        files[rel] = asSkillFile(new Uint8Array(bytes));
      }
    }
  }
  await walk(root, "");
  return files;
}

async function readSkillDir(dir: string): Promise<Skill | null> {
  const manifest = await readFile(join(dir, SKILL_MANIFEST), "utf8").catch(
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

/** Every directory under `root`, depth-first, up to a sane depth. */
async function directoriesUnder(root: string, depth = 0): Promise<string[]> {
  if (depth > MAX_DEPTH) {
    return [];
  }
  const entries = await readdir(root, { withFileTypes: true }).catch(() => []);
  const found: string[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || SKIPPED.has(entry.name)) {
      continue;
    }
    const dir = join(root, entry.name);
    found.push(dir, ...(await directoriesUnder(dir, depth + 1)));
  }
  return found;
}

function posix(path: string): string {
  return sep === "/" ? path : path.split(sep).join("/");
}

async function skillsIn(dirs: readonly string[]): Promise<Skill[]> {
  const read = await Promise.all(dirs.map((dir) => readSkillDir(dir)));
  return read.filter((skill): skill is Skill => skill !== null);
}

async function loadRoots(roots: SkillRoots): Promise<Skill[]> {
  const found: Skill[] = [];
  for (const root of [
    roots.global,
    join(roots.workspace, WORKSPACE_SKILLS_DIR),
  ]) {
    const entries = await readdir(root, { withFileTypes: true }).catch(
      () => []
    );
    const dirs = entries
      .filter((entry) => entry.isDirectory())
      .map((entry) => join(root, entry.name));
    found.push(...(await skillsIn(dirs)));
  }
  return found;
}

/**
 * The directories a glob names. The static prefix before the first glob
 * segment is resolved against the workspace, which is what lets `../x/*`
 * and absolute patterns work, and only the tree beneath it is walked.
 */
async function addGlob(glob: string, roots: SkillRoots): Promise<Skill[]> {
  const segments = posix(glob).replace(DOT_SLASH, "").split("/");
  const first = segments.findIndex((segment) => GLOB_SEGMENT.test(segment));
  const fixed = first === -1 ? segments : segments.slice(0, first);
  const base = resolve(roots.workspace, fixed.join("/") || ".");
  if (first === -1) {
    return skillsIn([base]);
  }
  const matcher = globToRegExp(segments.slice(first).join("/"));
  const dirs = (await directoriesUnder(base)).filter((dir) =>
    matcher.test(posix(relative(base, dir)))
  );
  return skillsIn(dirs);
}

export type SkillResolver = (set?: SkillSet) => Promise<Skill[]>;

function applyPick(skills: Map<string, Skill>, names: readonly string[]): void {
  const missing = names.filter((name) => !skills.has(name));
  if (missing.length > 0) {
    throw new Error(
      `skills.pick: unknown skill${missing.length > 1 ? "s" : ""} ${missing.join(", ")} (have: ${[...skills.keys()].join(", ") || "none"})`
    );
  }
  for (const name of [...skills.keys()]) {
    if (!names.includes(name)) {
      skills.delete(name);
    }
  }
}

async function applyOp(
  skills: Map<string, Skill>,
  op: SkillSet["ops"][number],
  roots: SkillRoots
): Promise<void> {
  if (op.kind === "pick") {
    applyPick(skills, op.names ?? []);
    return;
  }
  if (op.kind === "skill") {
    if (op.skill) {
      skills.set(op.skill.name, op.skill);
    }
    return;
  }
  const found =
    op.kind === "load"
      ? await loadRoots(roots)
      : await addGlob(op.glob ?? "", roots);
  for (const entry of found) {
    skills.set(entry.name, entry);
  }
}

/** A recipe step as a cache key; a defined skill by its name and a digest of what it is. */
function opKey(op: SkillOp): unknown {
  if (op.kind !== "skill" || !op.skill) {
    return op;
  }
  const { files = {}, ...rest } = op.skill;
  const digest = createHash("sha256");
  digest.update(JSON.stringify(rest));
  for (const [path, content] of Object.entries(files).sort(([a], [b]) =>
    a.localeCompare(b)
  )) {
    digest.update(`\0${path}\0`).update(content);
  }
  return { kind: "skill", name: op.skill.name, sha256: digest.digest("hex") };
}

export function skillResolver(roots: SkillRoots): SkillResolver {
  const cache = new Map<string, Promise<Skill[]>>();
  async function resolveSet(set: SkillSet): Promise<Skill[]> {
    const skills = new Map<string, Skill>();
    for (const op of set.ops) {
      await applyOp(skills, op, roots);
    }
    return [...skills.values()];
  }
  return (set) => {
    if (!set) {
      return Promise.resolve([]);
    }
    const key = JSON.stringify(set.ops.map(opKey));
    let pending = cache.get(key);
    if (!pending) {
      pending = resolveSet(set);
      cache.set(key, pending);
    }
    return pending;
  };
}

/** Where `skills.load()` looks besides the workspace: `~/.foundry/skills`. */
export function globalSkillsDir(home: string): string {
  return resolve(home, ".foundry", WORKSPACE_SKILLS_DIR);
}
