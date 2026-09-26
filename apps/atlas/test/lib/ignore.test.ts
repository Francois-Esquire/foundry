import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import { createProject } from "../../src/lib/analyze";
import { resolveBoundary, toPosix } from "../../src/lib/boundary";
import { collectCrossBoundaryEdges } from "../../src/lib/dependencies";
import { createIgnorer } from "../../src/lib/ignore";
import {
  DEFAULT_SEMANTICS_CONFIG,
  discoverSemanticsUnits,
} from "../../src/lib/semantics-discover";

const tempRoots: string[] = [];

afterAll(() => {
  for (const dir of tempRoots) {
    fs.rmSync(dir, { force: true, recursive: true });
  }
});

function fixture(files: Record<string, string>): string {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), "semantic-surface-ignore-")
  );
  tempRoots.push(root);
  for (const [file, content] of Object.entries(files)) {
    const target = path.join(root, file);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content);
  }
  return fs.realpathSync(root);
}

describe("createIgnorer", () => {
  it("applies root and nested .gitignore files like git", () => {
    const root = fixture({
      ".gitignore": "generated/\n*.log\n!important.log\n.claude/\n",
      "apps/web/.gitignore": ".astro/\n!generated/\n",
      "apps/web/src/index.ts": "",
    });
    const ignorer = createIgnorer(root);
    expect(ignorer.ignores("apps/web/src/index.ts")).toBe(false);
    expect(ignorer.ignores("apps/web/.astro/types.d.ts")).toBe(true);
    expect(ignorer.ignores("apps/web/.claude/skills/a.mjs")).toBe(true);
    expect(ignorer.ignores("debug.log")).toBe(true);
    expect(ignorer.ignores("apps/web/important.log")).toBe(false);
    // the nested negation re-includes a directory the root ignored
    expect(ignorer.ignores("apps/web/generated/")).toBe(false);
    expect(ignorer.ignores("apps/api/generated/")).toBe(true);
    // nothing below an ignored directory can be re-included
    expect(ignorer.ignores("apps/api/generated/important.log")).toBe(true);
  });

  it("ignores nothing without a .gitignore", () => {
    const root = fixture({ "src/index.ts": "" });
    expect(createIgnorer(root).ignores("src/index.ts")).toBe(false);
  });
});

describe("gitignored files stay out of the analysis", () => {
  const root = fixture({
    ".gitignore": ".claude/\npackages/vendored/\n",
    "package.json": JSON.stringify({
      name: "ignore-fixture",
      workspaces: ["packages/*"],
    }),
    "packages/app/.claude/hook.ts": 'import { keep } from "@ig/lib";\nkeep;\n',
    "packages/app/package.json": JSON.stringify({ name: "@ig/app" }),
    "packages/app/src/main.ts": 'import { keep } from "@ig/lib";\nkeep;\n',
    "packages/lib/.claude/tool.ts": 'import "@ig/lib";\n',
    "packages/lib/.gitignore": "generated/\n",
    "packages/lib/package.json": JSON.stringify({
      exports: { ".": "./src/index.ts" },
      name: "@ig/lib",
    }),
    "packages/lib/src/generated/gen.ts": "export const gen = 1;\n",
    "packages/lib/src/index.ts":
      'export { gen } from "./generated/gen";\nexport const keep = 1;\n',
    "packages/vendored/package.json": JSON.stringify({ name: "@ig/vendored" }),
    "packages/vendored/src/index.ts": 'import "@ig/lib";\n',
  });

  it("keeps them out of the ts-morph project", () => {
    const files = createProject(root)
      .getSourceFiles()
      .map((file) => toPosix(path.relative(root, file.getFilePath())))
      .sort();
    expect(files).toEqual([
      "packages/app/src/main.ts",
      "packages/lib/src/index.ts",
    ]);
  });

  it("keeps them out of the module graph and consumer edges", async () => {
    const edges = await collectCrossBoundaryEdges(
      root,
      resolveBoundary(root, "@ig/lib")
    );
    expect(edges.graph.modules).toEqual([
      "packages/app/src/main.ts",
      "packages/lib/src/index.ts",
    ]);
    expect(edges.graph.edges.map((edge) => edge.toFile)).toEqual([
      "packages/lib/src/index.ts",
    ]);
    expect([...edges.incoming.keys()]).toEqual(["@ig/app"]);
  });

  it("skips gitignored workspace units at discovery", () => {
    const discovery = discoverSemanticsUnits(root, {
      ...DEFAULT_SEMANTICS_CONFIG,
      roots: ["packages"],
    });
    expect(discovery.units.map((unit) => unit.id)).toEqual([
      "@ig/app",
      "@ig/lib",
    ]);
    expect(discovery.skipped).toEqual([
      { path: "packages/vendored", reason: "gitignored" },
    ]);
  });
});
