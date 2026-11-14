import {
  existsSync,
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
  analyzePackageLocal,
  preparePackageLocalSource,
} from "../../src/lib/package-local";
import type { PreparedPackageSource } from "../../src/lib/package-local-analysis";
import { analyzePreparedPackageLocal } from "../../src/lib/package-local-analysis";

// Package-local analysis over prepared sources. Preparation reads the disk;
// analysis must not. Relocating every prepared path below a root that does
// not exist makes any remaining manifest, tsconfig, source or ownership read
// lose its input, so an identical report shows the analysis used only the
// prepared values.

const fixture = join(import.meta.dirname, "fixtures", "semantics");
const virtualRoot = "/spyglass-virtual-prepared-root";
const tempRoots: string[] = [];

afterAll(() => {
  for (const dir of tempRoots) {
    rmSync(dir, { force: true, recursive: true });
  }
});

/** A workspace whose package imports itself through its name and both tsconfig alias sources. */
function selfAliasWorkspace(): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "package-prepared-")));
  tempRoots.push(root);
  const files: Record<string, string> = {
    "package.json": JSON.stringify({
      name: "root",
      workspaces: ["packages/*"],
    }),
    "packages/p/package.json": JSON.stringify({
      exports: { ".": "./src/index.ts" },
      name: "@f/p",
    }),
    "packages/p/src/a.ts": [
      'import { b } from "~/lib/b";',
      'import { c } from "#root/c";',
      'import { index } from "@f/p";',
      "export const a = b + c + index;",
      "",
    ].join("\n"),
    "packages/p/src/c.ts": "export const c = 3;\n",
    "packages/p/src/index.ts": "export const index = 0;\n",
    "packages/p/src/lib/b.ts": "export const b = 1;\n",
    "packages/p/tsconfig.json": JSON.stringify({
      compilerOptions: { paths: { "~/*": ["./src/*"] } },
    }),
    "tsconfig.json": JSON.stringify({
      compilerOptions: { paths: { "#root/*": ["packages/p/src/*"] } },
    }),
  };
  for (const [file, text] of Object.entries(files)) {
    const target = join(root, file);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, text);
  }
  return root;
}

/**
 * A declared package whose one source sits below a nested `package.json`
 * that does not parse and is no workspace member: that source's owner
 * lookup throws.
 */
function brokenOwnerWorkspace(source: string): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "package-owner-")));
  tempRoots.push(root);
  const files: Record<string, string> = {
    "package.json": JSON.stringify({
      private: true,
      workspaces: ["packages/*"],
    }),
    "packages/a/package.json": JSON.stringify({
      exports: "./src/nested/index.ts",
      name: "@fixture/a",
      private: true,
    }),
    "packages/a/src/nested/index.ts": source,
    "packages/a/src/nested/package.json": "{broken",
  };
  for (const [file, text] of Object.entries(files)) {
    const target = join(root, file);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, text);
  }
  return root;
}

/** What `run` threw, told apart from returning even when it threw `undefined`. */
function thrownBy(run: () => unknown): { value: unknown } | undefined {
  try {
    run();
  } catch (value) {
    return { value };
  }
  return undefined;
}

function relocate(source: PreparedPackageSource): PreparedPackageSource {
  const move = (path: string) => {
    expect(path.startsWith(source.root)).toBe(true);
    return `${virtualRoot}${path.slice(source.root.length)}`;
  };
  return {
    boundary: {
      ...source.boundary,
      dir: move(source.boundary.dir),
      root: virtualRoot,
    },
    compilerPaths: Object.fromEntries(
      Object.entries(source.compilerPaths).map(([key, targets]) => [
        key,
        targets.map(move),
      ])
    ),
    entrypoints: source.entrypoints,
    files: source.files.map((file) => ({ ...file, path: move(file.path) })),
    root: virtualRoot,
  };
}

describe("prepared package-local analysis", () => {
  it("keeps the native report with every input relocated off disk", () => {
    expect(existsSync(virtualRoot)).toBe(false);
    const options = {
      root: fixture,
      target: "packages/b",
      tsconfig: "tsconfig.json",
    };
    const prepared = preparePackageLocalSource(options);
    const native = analyzePackageLocal(options);

    // The facts a residual read at the virtual root would lose.
    expect(native.package.entrypoints).toEqual([
      { entrypoint: "@s/b", file: "packages/b/src/index.ts" },
    ]);
    expect(native.moduleRoles).toMatchObject({
      "packages/b/src/index.ts": { entrypoint: true },
    });
    expect(native.symbols.some((symbol) => symbol.packagePublic)).toBe(true);
    expect(native.conceptParticipation.length).toBeGreaterThan(0);
    expect(prepared.compilerPaths["@s/b"]).toEqual([
      join(prepared.root, "packages/b/src/index.ts"),
    ]);
    expect(
      prepared.files.map((file) => ("owner" in file ? file.owner : file))
    ).toEqual(prepared.files.map(() => "@s/b"));

    expect(
      JSON.stringify(analyzePreparedPackageLocal(relocate(prepared)))
    ).toBe(JSON.stringify(native));
  });

  it("keeps the declared public surface off disk", () => {
    const options = { root: fixture, target: "tooling/c" };
    const native = analyzePackageLocal(options);
    // Without its entrypoints every module export would count as public.
    expect(
      native.symbols.some((symbol) => symbol.exported && !symbol.packagePublic)
    ).toBe(true);
    expect(
      JSON.stringify(
        analyzePreparedPackageLocal(
          relocate(preparePackageLocalSource(options))
        )
      )
    ).toBe(JSON.stringify(native));
  });

  it("keeps a directory boundary's report off disk", () => {
    const options = { root: fixture, target: "packages/loose" };
    const prepared = preparePackageLocalSource(options);
    expect(prepared.boundary.type).toBe("directory");
    expect(prepared.entrypoints).toEqual([]);
    expect(
      JSON.stringify(analyzePreparedPackageLocal(relocate(prepared)))
    ).toBe(JSON.stringify(analyzePackageLocal(options)));
  });

  it("resolves the package's own aliases off disk", () => {
    const options = {
      root: selfAliasWorkspace(),
      target: "packages/p",
      tsconfig: "tsconfig.json",
    };
    const native = analyzePackageLocal(options);
    const targets = native.imports
      .filter((site) => site.sourceModule === "packages/p/src/a.ts")
      .map((site) => [site.specifier, site.scope, site.targetModule]);
    expect(targets).toEqual([
      ["@f/p", "internal", "packages/p/src/index.ts"],
      ["#root/c", "internal", "packages/p/src/c.ts"],
      ["~/lib/b", "internal", "packages/p/src/lib/b.ts"],
    ]);
    expect(
      JSON.stringify(
        analyzePreparedPackageLocal(
          relocate(preparePackageLocalSource(options))
        )
      )
    ).toBe(JSON.stringify(native));
  });

  it("defers an owner lookup's error to analysis, which raises that value off disk", () => {
    const root = brokenOwnerWorkspace(
      "export interface Item { value: number }\n"
    );
    const prepared = preparePackageLocalSource({ root, target: "packages/a" });
    const [file] = prepared.files;
    if (file === undefined || !("ownerError" in file)) {
      throw new Error("the nested source's owner lookup did not fail");
    }
    expect(file.ownerError).toBeInstanceOf(SyntaxError);
    rmSync(root, { force: true, recursive: true });
    const result = thrownBy(() => analyzePreparedPackageLocal(prepared));
    expect(result).toBeDefined();
    expect(result?.value).toBe(file.ownerError);
  });

  it("analyzes a package whose analysis never asks a failed lookup's owner", () => {
    const root = brokenOwnerWorkspace(
      "export function twice(x: number) { return x * 2; }\n"
    );
    const prepared = preparePackageLocalSource({ root, target: "packages/a" });
    expect(prepared.files.every((file) => "ownerError" in file)).toBe(true);
    rmSync(root, { force: true, recursive: true });
    expect(
      analyzePreparedPackageLocal(prepared).symbols.map((symbol) => symbol.name)
    ).toEqual(["twice"]);
  });

  it.each([
    ["undefined", undefined],
    ["null", null],
    ["false", false],
    ["0", 0],
    ["an empty string", ""],
  ])("raises a deferred owner error of %s exactly", (_label, thrown) => {
    const prepared = relocate(
      preparePackageLocalSource({ root: fixture, target: "packages/b" })
    );
    const files = prepared.files.map(({ path, text }) => ({
      ownerError: thrown,
      path,
      text,
    }));
    const result = thrownBy(() =>
      analyzePreparedPackageLocal({ ...prepared, files })
    );
    expect(result).toBeDefined();
    expect(result?.value).toBe(thrown);
  });

  it("reads file ownership from the prepared sources", () => {
    const prepared = relocate(
      preparePackageLocalSource({ root: fixture, target: "packages/b" })
    );
    const [first, ...rest] = prepared.files;
    if (first === undefined) {
      throw new Error("fixture package has no sources");
    }
    expect(() =>
      analyzePreparedPackageLocal({
        ...prepared,
        files: [{ ...first, owner: undefined as unknown as string }, ...rest],
      })
    ).toThrow(`No prepared owner for ${first.path}`);
  });
});
