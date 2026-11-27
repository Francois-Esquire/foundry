import { existsSync, readdirSync, readFileSync } from "node:fs";
import { basename, join, relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  APPS_DIR,
  DEPENDENCY_FIELDS,
  PACKAGES_DIR,
  packageDirs,
  REPO_ROOT,
  readManifest,
  sourceFiles,
  workspaceDirs,
} from "./helpers/scan";

const BUN_TEST_PATTERN = /\bbun\s+test\b/;
const FLOATING_EXEC_PATTERN = /\b(?:bunx|npx)\b/;
const CLEAN_FORBIDDEN_SEGMENT = /(?:^|\s)(?:\.env\S*|node_modules|src)(?:\s|$)/;
const CONTEXT_LINK_PATTERN = /\[[^\]]+\]\((\.\/[^)#]+)\)/g;
const TEST_FILE_PATTERN = /\.(?:test|spec)\.[cm]?[jt]sx?$/;

const ALLOWED_CLEAN_SCRIPTS: Readonly<Record<string, string>> = {
  "apps/marbles": "src/database/migrations",
};

const ALL_WORKSPACES = workspaceDirs();

describe("workspace manifest, script, and repository conventions", () => {
  it("defines a typecheck script in every workspace with a tsconfig.json", () => {
    const violations = ALL_WORKSPACES.filter(
      (dir) =>
        existsSync(join(dir, "tsconfig.json")) &&
        readManifest(dir).scripts?.typecheck === undefined
    ).map((dir) => `${relative(REPO_ROOT, dir)}: missing "typecheck" script`);
    expect(violations).toEqual([]);
  });

  it("uses Vitest for all test scripts (never bun test)", () => {
    const violations: string[] = [];
    for (const dir of [REPO_ROOT, ...ALL_WORKSPACES]) {
      const manifest = readManifest(dir);
      for (const [name, script] of Object.entries(manifest.scripts ?? {})) {
        if (BUN_TEST_PATTERN.test(script)) {
          violations.push(
            `${relative(REPO_ROOT, dir) || "."} scripts.${name}: uses "bun test"`
          );
        }
      }
    }
    expect(violations).toEqual([]);
  });

  it("uses no floating bunx/npx downloads in scripts or CI workflows", () => {
    const violations: string[] = [];
    for (const dir of [REPO_ROOT, ...ALL_WORKSPACES]) {
      const manifest = readManifest(dir);
      for (const [name, script] of Object.entries(manifest.scripts ?? {})) {
        if (FLOATING_EXEC_PATTERN.test(script)) {
          violations.push(
            `${relative(REPO_ROOT, dir) || "."} scripts.${name}: ${script}`
          );
        }
      }
    }

    const workflowsDir = join(REPO_ROOT, ".github/workflows");
    if (existsSync(workflowsDir)) {
      for (const entry of readdirSync(workflowsDir)) {
        if (!(entry.endsWith(".yml") || entry.endsWith(".yaml"))) {
          continue;
        }
        const path = join(workflowsDir, entry);
        const lines = readFileSync(path, "utf8").split("\n");
        for (const [index, line] of lines.entries()) {
          if (
            !line.trimStart().startsWith("#") &&
            FLOATING_EXEC_PATTERN.test(line)
          ) {
            violations.push(`.github/workflows/${entry}:${index + 1}: ${line}`);
          }
        }
      }
    }
    expect(violations).toEqual([]);
  });

  it("keeps dependency ranges explicit (no catalog:, latest, or *)", () => {
    const violations: string[] = [];
    for (const dir of [REPO_ROOT, ...ALL_WORKSPACES]) {
      const manifest = readManifest(dir);
      const label = relative(REPO_ROOT, dir) || ".";
      for (const field of DEPENDENCY_FIELDS) {
        for (const [dep, range] of Object.entries(manifest[field] ?? {})) {
          if (
            range.startsWith("catalog:") ||
            range === "latest" ||
            range === "*"
          ) {
            violations.push(`${label} ${field}.${dep}: "${range}"`);
          }
        }
      }
    }
    expect(violations).toEqual([]);
  });

  it("keeps clean scripts scoped to named generated directories", () => {
    const violations: string[] = [];
    for (const dir of [REPO_ROOT, ...ALL_WORKSPACES]) {
      const rel = relative(REPO_ROOT, dir) || ".";
      const script = readManifest(dir).scripts?.clean;
      if (!script) {
        continue;
      }
      const allowed = ALLOWED_CLEAN_SCRIPTS[rel];
      const sanitized = allowed ? script.replaceAll(allowed, "") : script;
      if (CLEAN_FORBIDDEN_SEGMENT.test(sanitized)) {
        violations.push(`${rel} scripts.clean: "${script}"`);
      }
    }
    expect(violations).toEqual([]);
  });

  it("keeps tests in src/test/ for packages/* and test/ for apps/*", () => {
    const violations: string[] = [];
    for (const dir of packageDirs(PACKAGES_DIR)) {
      const allowed = `${join(dir, "src/test")}/`;
      for (const file of sourceFiles(dir)) {
        if (TEST_FILE_PATTERN.test(file) && !file.startsWith(allowed)) {
          violations.push(relative(REPO_ROOT, file));
        }
      }
    }
    for (const dir of packageDirs(APPS_DIR)) {
      const allowed = `${join(dir, "test")}/`;
      for (const file of sourceFiles(dir)) {
        if (TEST_FILE_PATTERN.test(file) && !file.startsWith(allowed)) {
          violations.push(relative(REPO_ROOT, file));
        }
      }
    }
    expect(violations).toEqual([]);
  });

  it("keeps CONTEXT-MAP.md synchronized with packages/* and CONTEXT.md files", () => {
    const contextMapPath = join(REPO_ROOT, "CONTEXT-MAP.md");
    const content = readFileSync(contextMapPath, "utf8");
    const violations: string[] = [];

    for (const [, target] of content.matchAll(CONTEXT_LINK_PATTERN)) {
      if (target && !existsSync(resolve(REPO_ROOT, target))) {
        violations.push(`CONTEXT-MAP.md links to missing path "${target}"`);
      }
    }

    for (const dir of packageDirs(PACKAGES_DIR)) {
      const name = basename(dir);
      if (!content.includes(`packages/${name}`)) {
        violations.push(`CONTEXT-MAP.md does not reference packages/${name}`);
      }
    }

    for (const group of [PACKAGES_DIR, APPS_DIR]) {
      for (const dir of packageDirs(group)) {
        const contextFile = join(dir, "CONTEXT.md");
        if (!existsSync(contextFile)) {
          continue;
        }
        const rel = `./${relative(REPO_ROOT, contextFile).replaceAll("\\", "/")}`;
        if (!content.includes(rel)) {
          violations.push(`CONTEXT-MAP.md does not link ${rel}`);
        }
      }
    }

    expect(violations).toEqual([]);
  });
});
