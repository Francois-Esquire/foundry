import { readdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { parseFrontmatter } from "../skills/frontmatter";
import type { AgentSource, AgentSpec } from "./spec";

/** The `.md`-file variant of {@link AgentSource}. */
type FileSource = Extract<AgentSource, { kind: "file" }>;

/** Conventional locations agents live: `./agents`, `./.claude/agents`, `~/.claude/agents`. */
export function defaultAgentRoots(): string[] {
  return [
    join(process.cwd(), "agents"),
    join(process.cwd(), ".claude", "agents"),
    join(homedir(), ".claude", "agents"),
  ];
}

/** Split a frontmatter inline comma list (`a, b, c`) into trimmed, non-empty parts. */
function commaList(value: string | undefined): string[] {
  return (value ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * Parse one `.md` file's text into an {@link AgentSpec}, or `null` when it is
 * malformed (no resolvable id, or an empty body). Pure — no filesystem access —
 * so it is directly testable.
 */
export function parseAgentSpec(
  text: string,
  fallbackId: string,
  source: FileSource
): AgentSpec | null {
  const { data, body } = parseFrontmatter(text);

  const declaredName = data.name?.trim() ?? "";
  const id = declaredName.length > 0 ? declaredName : fallbackId;
  const prompt = body.trim();
  if (id === "" || prompt === "") {
    return null;
  }

  const model = data.model?.trim();
  const role = data.role?.trim();
  const skills = commaList(data.skills);
  return {
    id,
    ...(role ? { role } : {}),
    ...(model ? { model } : {}),
    prompt,
    ...(skills.length > 0 ? { skills } : {}),
    mcp: commaList(data.mcp),
    source,
    tools: commaList(data.tools),
  };
}

/**
 * Discover file-defined agents: scan the roots and parse one {@link AgentSpec}
 * per `*.md` file. Pure data — the durable "infrastructure-code" records; a
 * substrate provisions them into live agents via `resolveAgent(spec, surface)`.
 *
 * A root that doesn't exist is skipped; when the same id appears under multiple
 * roots the first wins. A malformed definition is logged and skipped — never
 * throws.
 */
export async function gatherAgents(roots: string[]): Promise<AgentSpec[]> {
  const specs: AgentSpec[] = [];
  const seen = new Set<string>();

  for (const root of roots) {
    const entries = await readdir(root, { withFileTypes: true }).catch(
      () => []
    );
    for (const entry of entries) {
      if (!(entry.isFile() && entry.name.endsWith(".md"))) {
        continue;
      }

      const path = join(root, entry.name);
      const text = await readFile(path, "utf8").catch(() => null);
      if (text === null) {
        continue;
      }

      const spec = parseAgentSpec(text, basename(entry.name, ".md"), {
        kind: "file",
        path,
        root,
      });
      if (!spec) {
        console.warn(
          `gatherAgents: skipping malformed agent definition at ${path}`
        );
        continue;
      }
      if (seen.has(spec.id)) {
        continue;
      }

      seen.add(spec.id);
      specs.push(spec);
    }
  }

  return specs;
}
