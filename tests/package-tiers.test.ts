import { readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";
import {
  APPS_DIR,
  DEPENDENCY_FIELDS,
  PACKAGES_DIR,
  type PackageManifest,
  packageDirs,
  parseModuleImports,
  REPO_ROOT,
  readManifest,
  sourceFiles,
} from "./helpers/scan";

type PackageTier = "primitives" | "tools" | "domains";

const PACKAGE_TIERS: Readonly<Record<string, PackageTier>> = {
  "@foundry/agents": "domains",
  "@foundry/artifacts": "domains",
  "@foundry/authorization": "domains",
  "@foundry/core": "primitives",
  "@foundry/lib": "primitives",
  "@foundry/models": "tools",
  "@foundry/modules": "domains",
  "@foundry/prompts": "tools",
  "@foundry/queue": "domains",
  "@foundry/sandbox": "domains",
  "@foundry/scheduling": "domains",
  "@foundry/tasks": "domains",
  "@foundry/usage": "tools",
  "@foundry/workflows": "domains",
  "@foundry/workspaces": "domains",
};

const TIER_RANK: Readonly<Record<PackageTier, number>> = {
  domains: 2,
  primitives: 0,
  tools: 1,
};

const UNTIERED_WORKSPACE_PACKAGES = new Set(["@foundry/tsconfig"]);
const SKIP_DIRS = ["node_modules", "dist", "out", ".turbo", ".cache"];
const TEST_OR_STORY_FILE = /\.(?:test|stories)\.(?:ts|tsx)$/;
const TEST_DIRECTORY = /\/(?:tests|test|testing)\//;
const LOOP_AGENT_CONSTRUCTOR = /new\s+(?:LoopAgent|ToolLoopAgent)\s*\(/;
const WORKFLOWS_IMPORT = /^@foundry\/workflows(?:\/|$)/;
const SANDBOX_IMPORT = /^@foundry\/sandbox(?:\/|$)/;
const AGENTS_IMPORT = /^@foundry\/agents(?:\/|$)/;
const COMPILED_TOOLS_PATTERN = /tools:\s*compiled\.tools/;
const RAW_TOOLS_SPREAD_PATTERN = /tools:\s*\{\s*\.\.\.tools/;

function allDependencyNames(manifest: PackageManifest): string[] {
  const names = new Set<string>();
  for (const field of DEPENDENCY_FIELDS) {
    for (const name of Object.keys(manifest[field] ?? {})) {
      names.add(name);
    }
  }
  return [...names].sort();
}

function foundryDependencies(manifest: PackageManifest): string[] {
  return allDependencyNames(manifest).filter(
    (name) =>
      name.startsWith("@foundry/") && !UNTIERED_WORKSPACE_PACKAGES.has(name)
  );
}

function findCycle(graph: ReadonlyMap<string, readonly string[]>): string[] {
  const done = new Set<string>();
  const path: string[] = [];
  const visit = (name: string): string[] | null => {
    const onPath = path.indexOf(name);
    if (onPath >= 0) {
      return [...path.slice(onPath), name];
    }
    if (done.has(name)) {
      return null;
    }
    path.push(name);
    for (const dep of graph.get(name) ?? []) {
      const cycle = visit(dep);
      if (cycle) {
        return cycle;
      }
    }
    path.pop();
    done.add(name);
    return null;
  };
  for (const name of graph.keys()) {
    const cycle = visit(name);
    if (cycle) {
      return cycle;
    }
  }
  return [];
}

function importsMatching(
  root: string,
  pattern: RegExp,
  options?: { includeTests?: boolean }
): string[] {
  const skipDirs = options?.includeTests ? SKIP_DIRS : [...SKIP_DIRS, "test"];
  return sourceFiles(root, { extensions: [".ts", ".tsx"], skipDirs })
    .filter((file) =>
      parseModuleImports(file).some(({ specifier }) => pattern.test(specifier))
    )
    .map((file) => relative(REPO_ROOT, file));
}

describe("package tiers and dependency graph", () => {
  it("classifies every packages/* package and enforces downward, acyclic tiers", () => {
    const graph = new Map<string, string[]>();
    for (const dir of packageDirs()) {
      const manifest = readManifest(dir);
      const name = manifest.name ?? relative(REPO_ROOT, dir);
      graph.set(name, foundryDependencies(manifest));
    }

    const violations: string[] = [];
    for (const name of graph.keys()) {
      if (!(name in PACKAGE_TIERS)) {
        violations.push(`${name}: not classified in PACKAGE_TIERS`);
      }
    }
    for (const name of Object.keys(PACKAGE_TIERS)) {
      if (!graph.has(name)) {
        violations.push(`${name}: classified in PACKAGE_TIERS but not found`);
      }
    }
    for (const [name, deps] of graph) {
      const tier = PACKAGE_TIERS[name];
      for (const dep of deps) {
        const depTier = PACKAGE_TIERS[dep];
        if (!graph.has(dep)) {
          violations.push(`${name}: depends on ${dep} outside packages/*`);
        } else if (tier && depTier && TIER_RANK[depTier] > TIER_RANK[tier]) {
          violations.push(
            `${name} (${tier}) must not depend on ${dep} (${depTier})`
          );
        }
      }
    }

    const cycle = findCycle(graph);
    if (cycle.length > 0) {
      violations.push(`dependency cycle: ${cycle.join(" -> ")}`);
    }

    expect(violations).toEqual([]);
  });

  it("keeps @foundry/agents independent of @foundry/workflows and @foundry/sandbox", () => {
    const agentsSrc = join(PACKAGES_DIR, "agents/src");
    const workflowsSrc = join(PACKAGES_DIR, "workflows/src");

    expect(
      importsMatching(agentsSrc, WORKFLOWS_IMPORT, {
        includeTests: true,
      })
    ).toEqual([]);
    expect(
      importsMatching(agentsSrc, SANDBOX_IMPORT, {
        includeTests: true,
      })
    ).toEqual([]);
    expect(
      importsMatching(workflowsSrc, AGENTS_IMPORT, {
        includeTests: true,
      })
    ).toEqual([]);
  });

  it("keeps @foundry/sandbox dependent only on Core and Lib, with no browser or daemon providers", () => {
    const sandboxDeps = allDependencyNames(
      readManifest(join(PACKAGES_DIR, "sandbox"))
    );
    expect(sandboxDeps.filter((name) => name.startsWith("@foundry/"))).toEqual([
      "@foundry/core",
      "@foundry/lib",
      "@foundry/tsconfig",
    ]);

    const forbidden = new Set([
      "@webcontainer/api",
      "dockerode",
      "tar-stream",
      "@types/dockerode",
      "@types/tar-stream",
    ]);
    expect(sandboxDeps.filter((name) => forbidden.has(name))).toEqual([]);

    const violations = sourceFiles(join(PACKAGES_DIR, "sandbox/src")).flatMap(
      (file) =>
        parseModuleImports(file)
          .filter(({ specifier }) => forbidden.has(specifier))
          .map(
            ({ line, specifier }) =>
              `${relative(REPO_ROOT, file)}:${line} imports ${specifier}`
          )
    );
    expect(violations).toEqual([]);
  });

  it("keeps @foundry/workspaces dependent only on Core and Lib, with no Electron or app deps", () => {
    const workspaceDeps = allDependencyNames(
      readManifest(join(PACKAGES_DIR, "workspaces"))
    );
    const forbidden = workspaceDeps.filter(
      (name) =>
        name === "electron" ||
        name.startsWith("apps/") ||
        name.startsWith("@foundry.sh/") ||
        (name.startsWith("@foundry/") &&
          !["@foundry/core", "@foundry/lib", "@foundry/tsconfig"].includes(
            name
          ))
    );
    expect(forbidden).toEqual([]);
  });

  it("confines non-type microsandbox imports across packages/* to the VM adapter", () => {
    const adapter = "packages/sandbox/src/node/microsandbox.ts";
    const violations = sourceFiles(PACKAGES_DIR)
      .filter(
        (file) => !(TEST_OR_STORY_FILE.test(file) || TEST_DIRECTORY.test(file))
      )
      .flatMap((file) =>
        parseModuleImports(file)
          .filter(
            ({ specifier, typeOnly }) =>
              specifier === "microsandbox" && !typeOnly
          )
          .filter(() => relative(REPO_ROOT, file) !== adapter)
          .map(
            () =>
              `${relative(REPO_ROOT, file)} imports microsandbox outside ${adapter}`
          )
      );
    expect(violations).toEqual([]);
  });

  it("confines LoopAgent/ToolLoopAgent construction across agents and apps to the harness", () => {
    const allowlist = new Set(["packages/agents/src/harness/agent-harness.ts"]);
    const scan = (root: string): string[] =>
      sourceFiles(root, {
        extensions: [".ts", ".tsx"],
        skipDirs: [...SKIP_DIRS, "test"],
      })
        .filter((file) =>
          LOOP_AGENT_CONSTRUCTOR.test(readFileSync(file, "utf8"))
        )
        .map((file) => relative(REPO_ROOT, file));

    const found = new Set([
      ...scan(join(PACKAGES_DIR, "agents/src")),
      ...scan(APPS_DIR),
    ]);
    expect([...found].sort()).toEqual([...allowlist].sort());

    const harness = readFileSync(
      join(PACKAGES_DIR, "agents/src/harness/agent-harness.ts"),
      "utf8"
    );
    expect(harness).toContain("compileTools(tools ?? {}");
    expect(harness).toMatch(COMPILED_TOOLS_PATTERN);
    expect(harness).not.toMatch(RAW_TOOLS_SPREAD_PATTERN);
  });

  it("keeps @foundry/modules platform's @foundry/sandbox imports exact and type-only", () => {
    const modulesSrc = join(PACKAGES_DIR, "modules/src");
    const violations = sourceFiles(modulesSrc, {
      extensions: [".ts", ".tsx"],
      skipDirs: [...SKIP_DIRS, "test", "testing"],
    }).flatMap((file) => {
      const rel = relative(modulesSrc, file).replaceAll("\\", "/");
      return parseModuleImports(file)
        .filter(({ specifier }) => specifier.startsWith("@foundry/sandbox"))
        .flatMap(({ specifier, typeOnly }) => {
          const issues: string[] = [];
          if (!rel.startsWith("platform/")) {
            issues.push(`${rel} imports ${specifier} outside platform/`);
          }
          if (specifier !== "@foundry/sandbox") {
            issues.push(`${rel} imports subpath ${specifier}`);
          }
          if (!typeOnly) {
            issues.push(`${rel} imports value from ${specifier}`);
          }
          return issues;
        });
    });
    expect(violations).toEqual([]);
  });
});
