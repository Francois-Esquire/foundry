import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import {
  findRepoRoot,
  normalizeWorkspacePath,
  ownerBoundary,
  workspaceDeclaration,
  workspacePatterns,
} from "../../src/lib/boundary";

const tempRoots: string[] = [];

afterAll(() => {
  for (const dir of tempRoots) {
    rmSync(dir, { force: true, recursive: true });
  }
});

function fixture(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "semantic-surface-boundary-"));
  tempRoots.push(root);
  for (const [file, content] of Object.entries(files)) {
    const target = join(root, file);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, content);
  }
  return realpathSync(root);
}

const manifest = (name: string) => JSON.stringify({ name });
const INVALID_YAML = /^pnpm-workspace\.yaml: the file is not valid YAML: /;

describe("ownerBoundary", () => {
  it("folds a manifest outside the workspace patterns into its enclosing package", () => {
    const root = fixture({
      "package.json": JSON.stringify({
        name: "root",
        workspaces: ["packages/*"],
      }),
      "packages/a/nested/lib.ts": "",
      "packages/a/nested/package.json": manifest("@x/nested"),
      "packages/a/package.json": manifest("@x/a"),
      "packages/a/src/index.ts": "",
      "scripts/x.ts": "",
    });
    const owner = (file: string) => ownerBoundary(root, join(root, file));
    expect(owner("packages/a/src/index.ts")).toBe("@x/a");
    expect(owner("packages/a/nested/lib.ts")).toBe("@x/a");
    expect(owner("scripts/x.ts")).toBe("<root>");
  });

  it("uses the nearest manifest when the root declares no workspaces", () => {
    const root = fixture({
      "lib/inner/a.ts": "",
      "lib/inner/package.json": manifest("inner"),
      "package.json": manifest("root"),
    });
    expect(ownerBoundary(root, join(root, "lib/inner/a.ts"))).toBe("inner");
  });
});

describe("workspacePatterns", () => {
  it("reads package.json#workspaces, drops negations, and trims trailing slashes", () => {
    const root = fixture({
      "package.json": JSON.stringify({
        workspaces: ["apps/*", "docs/", "!apps/legacy"],
      }),
    });
    expect(workspacePatterns(root)).toEqual(["apps/*", "docs"]);
    expect(workspaceDeclaration(root)).toEqual({
      declared: ["apps/*", "docs/", "!apps/legacy"],
      patterns: ["apps/*", "docs"],
      source: "package.json#workspaces",
    });
  });

  it("ignores patterns that resolve to the workspace root or escape it", () => {
    const root = fixture({
      "package.json": JSON.stringify({
        workspaces: [".", "./", "../*", "apps/../*", "./apps/*", "*"],
      }),
    });
    expect(workspacePatterns(root)).toEqual(["apps/*", "*"]);
  });

  it("reads the packages object form", () => {
    const root = fixture({
      "package.json": JSON.stringify({ workspaces: { packages: ["libs/*"] } }),
    });
    expect(workspacePatterns(root)).toEqual(["libs/*"]);
  });

  it("prefers pnpm-workspace.yaml#packages over package.json#workspaces", () => {
    const root = fixture({
      "package.json": JSON.stringify({ workspaces: ["apps/*"] }),
      "pnpm-workspace.yaml":
        "# the pnpm list\npackages:\n  - 'packages/*'\n  - \"tools/*/\"\n  - '!**/test/**'\ncatalog:\n  zod: ^4.0.0\n",
    });
    expect(workspaceDeclaration(root)).toEqual({
      declared: ["packages/*", "tools/*/", "!**/test/**"],
      patterns: ["packages/*", "tools/*"],
      source: "pnpm-workspace.yaml",
    });
  });

  it("falls back to package.json when pnpm-workspace.yaml lists no packages", () => {
    const root = fixture({
      "package.json": JSON.stringify({ workspaces: ["apps/*"] }),
      "pnpm-workspace.yaml": "catalog:\n  zod: ^4.0.0\n",
    });
    expect(workspaceDeclaration(root)?.source).toBe("package.json#workspaces");
  });

  it("is undefined when the workspace declares nothing", () => {
    const root = fixture({ "package.json": manifest("solo") });
    expect(workspaceDeclaration(root)).toBeUndefined();
    expect(workspacePatterns(root)).toEqual([]);
  });

  it("fails on a pnpm-workspace.yaml that is not YAML or not a list of strings", () => {
    const broken = fixture({ "pnpm-workspace.yaml": "packages: [apps/*\n" });
    expect(() => workspacePatterns(broken)).toThrow(INVALID_YAML);
    const mistyped = fixture({ "pnpm-workspace.yaml": "packages: apps/*\n" });
    expect(() => workspacePatterns(mistyped)).toThrow(
      "pnpm-workspace.yaml: packages must be a list of strings."
    );
  });

  it("sees an edited declaration on the next read", () => {
    const root = fixture({
      "package.json": JSON.stringify({ workspaces: ["apps/*"] }),
    });
    expect(workspacePatterns(root)).toEqual(["apps/*"]);
    writeFileSync(
      join(root, "package.json"),
      JSON.stringify({ workspaces: ["apps/*", "libs/*"] })
    );
    expect(workspacePatterns(root)).toEqual(["apps/*", "libs/*"]);
  });
});

describe("normalizeWorkspacePath", () => {
  it("spells a workspace-relative path one way and refuses the rest", () => {
    expect(normalizeWorkspacePath("./packages/a/")).toBe("packages/a");
    expect(normalizeWorkspacePath("packages/a")).toBe("packages/a");
    for (const path of [
      "",
      ".",
      "./",
      "..",
      "../a",
      "/a",
      "a//b",
      "a/./b",
      "a\\b",
    ]) {
      expect(normalizeWorkspacePath(path)).toBeUndefined();
    }
  });
});

describe("findRepoRoot", () => {
  it("finds a workspace that only pnpm-workspace.yaml declares", () => {
    const root = fixture({
      "packages/a/src/index.ts": "export {};\n",
      "pnpm-workspace.yaml": "packages:\n  - packages/*\n",
    });
    expect(findRepoRoot(join(root, "packages", "a", "src"))).toBe(root);
  });
});
