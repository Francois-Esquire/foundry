import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

/** Agents and workflows remain independent; apps compose them through the harness. */
const AGENTS_SRC = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const REPO_ROOT = resolve(AGENTS_SRC, "../../..");
const WORKFLOWS_SRC = resolve(REPO_ROOT, "packages/workflows/src");
const APPS_ROOT = resolve(REPO_ROOT, "apps");

const SKIP_DIRS = new Set(["node_modules", "dist", "out", ".turbo", ".cache"]);

function sourceFilesUnder(
  root: string,
  opts: { includeTests: boolean } = { includeTests: true }
): string[] {
  const files: string[] = [];
  const pending = [root];
  while (pending.length > 0) {
    const dir = pending.pop();
    if (dir === undefined) {
      continue;
    }
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name)) {
          continue;
        }
        if (!opts.includeTests && entry.name === "test") {
          continue;
        }
        pending.push(join(dir, entry.name));
        continue;
      }
      if (/\.tsx?$/.test(entry.name)) {
        files.push(join(dir, entry.name));
      }
    }
  }
  return files;
}

const IMPORT_SPECIFIER =
  /(?:\bfrom\s+|\bimport\s*\(|\bvi\.mock\s*\(|\brequire\s*\()\s*["'](?<spec>[^"']+)["']/g;

function importsMatching(file: string, pattern: RegExp): string[] {
  const source = readFileSync(file, "utf8");
  const specs: string[] = [];
  for (const match of source.matchAll(IMPORT_SPECIFIER)) {
    const spec = match.groups?.spec;
    if (spec && pattern.test(spec)) {
      specs.push(spec);
    }
  }
  return specs;
}

describe("architecture boundary — package independence", () => {
  it("finds no @foundry/workflows import anywhere in packages/agents/src", () => {
    const violations = sourceFilesUnder(AGENTS_SRC)
      .filter(
        (file) =>
          importsMatching(file, /^@foundry\/workflows(?:\/|$)/).length > 0
      )
      .map((file) => relative(REPO_ROOT, file));
    expect(violations).toEqual([]);
  });

  it("finds no @foundry/agents import anywhere in packages/workflows/src", () => {
    const violations = sourceFilesUnder(WORKFLOWS_SRC)
      .filter(
        (file) => importsMatching(file, /^@foundry\/agents(?:\/|$)/).length > 0
      )
      .map((file) => relative(REPO_ROOT, file));
    expect(violations).toEqual([]);
  });
});

const LOOP_AGENT_CONSTRUCTOR = /new\s+(?:LoopAgent|ToolLoopAgent)\s*\(/;

/**
 * The complete, curated set of `new LoopAgent(...)`/`new ToolLoopAgent(...)`
 * call sites inside this architecture's own scope. A file entering this list
 * must justify why its tool set either never leaves the compiler
 * (`compileRegistrations`/`compiled.tools`) or carries no tools at all.
 */
const KNOWN_CONSTRUCTOR_SITES: Readonly<Record<string, string>> = {
  "packages/agents/src/agents/loop-agent.ts":
    "`createLoopAgent`, a thin `new LoopAgent(config, context)` factory around the same class `AgentHarness` wraps. No production caller exists anywhere in the repo (searched at `packages/agents/src/agents/loop-agent.ts` and `apps/`); it is dead exported surface, not a live bypass.",
  "packages/agents/src/harness/agent-harness.ts":
    "the harness itself; tools are `compiled.tools` from `compileRegistrations` — every tool source passed through the one policy/effect-gated compiler.",
};

function scanForRawConstructors(root: string): string[] {
  return sourceFilesUnder(root, { includeTests: false })
    .filter((file) => LOOP_AGENT_CONSTRUCTOR.test(readFileSync(file, "utf8")))
    .map((file) => relative(REPO_ROOT, file));
}

describe("architecture boundary — no tool-assembly bypass", () => {
  it("finds no LoopAgent/ToolLoopAgent construction in packages/agents/src or apps outside the curated set", () => {
    const found = new Set([
      ...scanForRawConstructors(AGENTS_SRC),
      ...scanForRawConstructors(APPS_ROOT),
    ]);
    const known = new Set(Object.keys(KNOWN_CONSTRUCTOR_SITES));

    const unexpected = [...found].filter((file) => !known.has(file));
    expect(
      unexpected,
      "a new LoopAgent/ToolLoopAgent construction site appeared outside the curated allowlist — add it to KNOWN_CONSTRUCTOR_SITES with justification, or route it through the compiler"
    ).toEqual([]);

    const missing = [...known].filter((file) => !found.has(file));
    expect(
      missing,
      "a curated construction site no longer constructs a LoopAgent/ToolLoopAgent — remove its stale allowlist entry"
    ).toEqual([]);
  });

  it("confirms the plain tool map still funnels through compileRegistrations rather than a raw spread onto the agent's tool set", () => {
    const source = readFileSync(
      join(AGENTS_SRC, "harness/agent-harness.ts"),
      "utf8"
    );
    // The caller's `tools` map goes through `compileTools`; the constructed
    // `LoopAgent` only ever receives `compiled.tools`, never `tools` (or any
    // other raw map) directly.
    expect(source).toContain("compileTools(tools ?? {}");
    expect(source).toMatch(/tools:\s*compiled\.tools/);
    expect(source).not.toMatch(/tools:\s*\{\s*\.\.\.tools/);
  });
});
