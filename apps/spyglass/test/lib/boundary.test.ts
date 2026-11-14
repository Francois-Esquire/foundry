import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import {
  findRepoRoot,
  ownerBoundary,
  packagePathAliases,
  workspaceDeclaration,
  workspacePatterns,
} from "../../src/lib/boundary";
import { normalizeWorkspacePath } from "../../src/lib/boundary-manifest";
import { ownerFromDirectories } from "../../src/lib/boundary-model";
import { snapshotDirectoryOwnership } from "./helpers/directory-ownership";

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

describe("ownerFromDirectories", () => {
  function ownershipTree(rootManifest: Record<string, unknown>): string {
    const root = fixture({
      "broken/b.ts": "",
      "broken/package.json": "{",
      "empty-name/e.ts": "",
      "empty-name/package.json": JSON.stringify({ name: "" }),
      "lib/inner/deep/a.ts": "",
      "lib/inner/package.json": manifest("inner"),
      "node_modules/dep/index.d.ts": "",
      "node_modules/dep/package.json": manifest("dep"),
      "package.json": JSON.stringify(rootManifest),
      "packages/a/package.json": manifest("@x/a"),
      "packages/a/src/x.ts": "",
      "packages/a/test/fixtures/fx/package.json": manifest("fx"),
      "packages/a/test/fixtures/fx/x.ts": "",
      "packages/bare/src/x.ts": "",
      "packages/unnamed/package.json": "{}",
      "packages/unnamed/u.ts": "",
      "plain/a.ts": "",
      "top.ts": "",
    });
    symlinkSync(join(root, "packages/a"), join(root, "linked"));
    const sibling = `${root}-sib`;
    tempRoots.push(sibling);
    mkdirSync(join(sibling, "pkg"), { recursive: true });
    writeFileSync(join(sibling, "pkg/package.json"), manifest("sib"));
    return root;
  }

  function compare(root: string, file: string) {
    const snapshot = snapshotDirectoryOwnership(root);
    const absolute = file.startsWith("/") ? file : join(root, file);
    const outcome = (owner: () => string) => {
      try {
        return { owner: owner() };
      } catch (error) {
        return { error: (error as Error).message };
      }
    };
    return {
      native: outcome(() => ownerBoundary(root, absolute)),
      prepared: outcome(() => ownerFromDirectories(snapshot, absolute)),
    };
  }

  const same = (owner: string) => ({
    native: { owner },
    prepared: { owner },
  });

  it("matches the nearest manifest below a standalone root", () => {
    const root = ownershipTree({ name: "root" });
    expect(compare(root, "top.ts")).toEqual(same("<root>"));
    expect(compare(root, "plain/a.ts")).toEqual(same("<root>"));
    expect(compare(root, "lib/inner/deep/a.ts")).toEqual(same("inner"));

    expect(compare(root, "packages/a/test/fixtures/fx/x.ts")).toEqual(
      same("fx")
    );
    expect(compare(root, "packages/unnamed/u.ts")).toEqual(
      same("packages/unnamed")
    );
    expect(compare(root, "empty-name/e.ts")).toEqual(same(""));

    expect(compare(root, "lib/inner/later/made.ts")).toEqual(same("inner"));
    expect(compare(root, "missing/made.ts")).toEqual(same("<root>"));
    expect(compare(root, join(dirname(root), "elsewhere.ts"))).toEqual(
      same("<root>")
    );
  });

  it("folds nested manifests into workspace members below a workspace root", () => {
    const root = ownershipTree({ name: "root", workspaces: ["packages/*"] });
    expect(compare(root, "top.ts")).toEqual(same("<root>"));
    expect(compare(root, "packages/a/src/x.ts")).toEqual(same("@x/a"));
    expect(compare(root, "packages/a/test/fixtures/fx/x.ts")).toEqual(
      same("@x/a")
    );

    expect(compare(root, "packages/bare/src/x.ts")).toEqual(same("<root>"));
    expect(compare(root, "packages/unnamed/u.ts")).toEqual(
      same("packages/unnamed")
    );

    expect(compare(root, "lib/inner/deep/a.ts")).toEqual(same("<root>"));
  });

  it.each([{ name: "root" }, { name: "root", workspaces: ["packages/*"] }])(
    "throws where it cannot know the native owner (%o)",
    (rootManifest) => {
      const root = ownershipTree(rootManifest);
      const parse = compare(root, "broken/b.ts");
      expect(parse.native).toHaveProperty("error");
      expect(parse.prepared).toEqual(parse.native);

      const notWalked = (file: string, dir: string) => ({
        error: `No prepared directory ownership for ${join(root, file)}: ${join(root, dir)} was not walked`,
      });
      const viaLink = compare(root, "linked/src/x.ts");

      expect(viaLink.native).toEqual({ owner: "@x/a" });
      expect(viaLink.prepared).toEqual(notWalked("linked/src/x.ts", "linked"));
      const installed = compare(root, "node_modules/dep/index.d.ts");
      expect(installed.native).toEqual({
        owner: rootManifest.workspaces === undefined ? "dep" : "<root>",
      });
      expect(installed.prepared).toEqual(
        notWalked("node_modules/dep/index.d.ts", "node_modules")
      );

      const siblingFile = `${root}-sib/pkg/x.ts`;
      const sibling = compare(root, siblingFile);
      expect(sibling.native).toEqual({
        owner: rootManifest.workspaces === undefined ? "sib" : "<root>",
      });
      expect(sibling.prepared).toEqual({
        error: `${siblingFile} is outside ${root} but shares its prefix; its owner was not prepared`,
      });

      expect(compare(root, `${root}/plain/../top.ts`).prepared).toEqual({
        error: `Cannot own a non-normalized path: ${root}/plain/../top.ts`,
      });
    }
  );
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

  it("trims a long run of slashes in one pass", () => {
    const run = "/".repeat(200_000);
    expect(normalizeWorkspacePath(`packages${run}`)).toBe("packages");
    expect(normalizeWorkspacePath(`a${run}b`)).toBeUndefined();
  });
});

describe("packagePathAliases", () => {
  it("prefers import, then default, then the rest, and visits each export condition once", () => {
    const preferred = fixture({
      "package.json": JSON.stringify({
        exports: {
          ".": { default: "./b.ts", import: "./c.ts", types: "./a.ts" },
          "./other": { default: "./e.js", node: "./d.ts" },
        },
        name: "@fixture/conditions",
      }),
    });
    expect(packagePathAliases(preferred)).toEqual({
      "@fixture/conditions": [join(preferred, "c.ts")],
      "@fixture/conditions/other": [join(preferred, "d.ts")],
    });

    let conditions: unknown = "./index.js";
    for (let depth = 0; depth < 40; depth += 1) {
      conditions = { default: "./index.js", import: conditions };
    }
    const nested = fixture({
      "package.json": JSON.stringify({
        exports: { ".": conditions },
        name: "@fixture/nested",
      }),
    });
    expect(packagePathAliases(nested)).toEqual({});
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
