import { afterEach, describe, expect, it } from "vitest";
import { resolveDependencyGraph } from "../../src/lib/dependency-graph";
import { collectDependencyInventory } from "../../src/lib/dependency-inventory";
import { requireDeclared } from "../../src/lib/discovery-rules";
import { prepareFileMap } from "../../src/lib/file-map-preparation";
import { createProject } from "../../src/lib/project";
import { rootName } from "../../src/lib/semantics";
import { discoverSemanticsUnits } from "../../src/lib/semantics-discover";
import { DEFAULT_CONFIGURATION } from "../../src/lib/spyglass-config";
import { fileMapDisk } from "./helpers/file-map";

const ROOT = "/spyglass-file-map";
const NOW = new Date("2026-11-07T00:00:00Z");
const disk = fileMapDisk("discovery-rules-");
afterEach(() => disk.cleanup());

const json = (value: unknown) => JSON.stringify(value);
const source = "export const value = 1;\n";
const SYNTAX_ERROR = /^SyntaxError: /;

function native(files: Record<string, string>, exclude: string[] = []) {
  const root = disk.materialize(files);
  const discovery = discoverSemanticsUnits(root, {
    ...DEFAULT_CONFIGURATION,
    exclude,
  });
  if (discovery.declarationSource === undefined) {
    return { discovery, inventory: undefined, root, workspaceName: undefined };
  }
  const inventory = collectDependencyInventory(
    root,
    requireDeclared(root, discovery)
  );
  inventory.graph = resolveDependencyGraph(root, inventory);
  return { discovery, inventory, root, workspaceName: rootName(root) };
}

async function fromMap(files: Record<string, string>, exclude: string[] = []) {
  const prepared = await prepareFileMap({
    exclude,
    files,
    now: NOW,
    root: ROOT,
  });
  return {
    discovery: prepared.discovery,
    inventory: prepared.inventory,
    targets: prepared.targets,
    workspaceName: prepared.workspaceName,
  };
}

async function rejected(pending: Promise<unknown>): Promise<string> {
  try {
    await pending;
  } catch (error) {
    return thrown(() => {
      throw error;
    });
  }
  return "no error";
}

function thrown(run: () => unknown): string {
  try {
    run();
  } catch (error) {
    return error instanceof Error
      ? `${error.constructor.name}: ${error.message}`
      : String(error);
  }
  throw new Error("expected an error");
}

const WORKSPACE: Record<string, string> = {
  ".gitignore": "packages/ignored/\n",
  "package.json": json({
    devDependencies: { tooling: "1.0.0" },
    name: "root-ws",
    workspaces: ["packages/*", "missing/*", "!packages/negated", "./"],
  }),
  "packages/.hidden/index.ts": source,
  "packages/.hidden/package.json": json({ name: "@x/hidden" }),
  "packages/build-only/build/index.ts": source,
  "packages/build-only/package.json": json({ name: "@x/build-only" }),
  "packages/dist/index.ts": source,
  "packages/dist/package.json": json({ name: "@x/dist" }),
  "packages/docs/package.json": json({ name: "@x/docs", version: "1.0.0" }),
  "packages/docs/README.md": "# docs\n",
  "packages/dts-only/index.d.ts": "export declare const value: number;\n",
  "packages/dts-only/package.json": json({ name: "@x/dts-only" }),
  "packages/empty-name/index.ts": source,
  "packages/empty-name/package.json": json({ name: "" }),
  "packages/excluded/index.ts": source,
  "packages/excluded/package.json": json({ name: "@x/excluded" }),
  "packages/file.txt": "not a directory\n",
  "packages/ignored/index.ts": source,
  "packages/ignored/package.json": json({ name: "@x/ignored" }),
  "packages/nested/package.json": json({
    dependencies: { "@x/ok": "workspace:*" },
    name: "@x/nested",
  }),
  "packages/nested/src/deep/view.tsx": "export const View = 1;\n",
  "packages/no-manifest/index.ts": source,
  "packages/ok/package.json": json({
    dependencies: { "left-pad": "^1.3.0", odd: 3 },
    devDependencies: ["not", "a", "record"],
    name: "@x/ok",
    peerDependencies: { react: "^19.0.0" },
    peerDependenciesMeta: { react: { optional: true } },
    version: "2.0.0",
  }),
  "packages/ok/src/index.ts": source,
  "packages/unnamed/index.ts": source,
  "packages/unnamed/package.json": json({}),
};

describe("discovery over a file map", () => {
  it("gives native discovery's units, skips and unmatched patterns", async () => {
    const exclude = ["packages/excluded", "packages/never"];
    const expected = native(WORKSPACE, exclude);
    const actual = await fromMap(WORKSPACE, exclude);
    expect(actual.discovery).toEqual(expected.discovery);
    expect(actual.targets).toEqual(["packages/nested", "packages/ok"]);
    expect(
      Object.fromEntries(
        actual.discovery.skipped.map((entry) => [
          entry.path,
          [entry.reason, entry.name ?? null],
        ])
      )
    ).toEqual({
      "packages/.hidden": ["generated output", "@x/hidden"],
      "packages/build-only": ["analysis unsupported", "@x/build-only"],
      "packages/dist": ["generated output", "@x/dist"],
      "packages/docs": ["analysis unsupported", "@x/docs"],
      "packages/dts-only": ["analysis unsupported", "@x/dts-only"],
      "packages/empty-name": ["no package manifest", null],
      "packages/excluded": ["excluded", "@x/excluded"],
      "packages/ignored": ["gitignored", "@x/ignored"],
      "packages/no-manifest": ["no package manifest", null],
      "packages/unnamed": ["no package manifest", null],
    });
    expect(actual.discovery.packagePatternsUnmatched).toEqual(["missing/*"]);
    expect(actual.discovery.excludeUnmatched).toEqual(["packages/never"]);
  });

  it("gives the native inventory, lockless graph and workspace name", async () => {
    const expected = native(WORKSPACE, ["packages/excluded"]);
    const actual = await fromMap(WORKSPACE, ["packages/excluded"]);
    expect(actual.inventory).toEqual(expected.inventory);
    expect(actual.workspaceName).toBe("root-ws");
    expect(actual.workspaceName).toBe(expected.workspaceName);
    expect(actual.inventory?.graph?.resolution.status).toBe("unavailable");
    expect(actual.inventory?.packages.map((pkg) => pkg.id)).toEqual([
      "@x/build-only",
      "@x/docs",
      "@x/dts-only",
      "@x/nested",
      "@x/ok",
      "workspace-root:",
    ]);
  });

  it("inspects a standalone package and its nested packages as natively", async () => {
    const standalone = {
      "package.json": json({ name: "solo" }),
      "src/index.ts": source,
    };
    const nestedOnly = {
      "package.json": json({ name: "solo" }),
      "sub/a.ts": source,
      "sub/package.json": json({ name: "sub" }),
    };
    for (const files of [standalone, nestedOnly]) {
      const expected = native(files);
      const actual = await fromMap(files);
      expect(actual.discovery).toEqual(expected.discovery);
      expect(actual.inventory).toEqual(expected.inventory);
    }
    expect((await fromMap(standalone)).targets).toEqual([""]);
    expect((await fromMap(nestedOnly)).discovery.skipped).toEqual([
      { name: "solo", path: "", reason: "analysis unsupported" },
    ]);
  });

  it("finds no declaration where native discovery finds none", async () => {
    const files = { "a.ts": source, "package.json": json({ private: true }) };
    const expected = native(files);
    const actual = await fromMap(files);
    expect(actual.discovery).toEqual(expected.discovery);
    expect(actual.discovery.declarationSource).toBeUndefined();
    expect(actual.inventory).toBeUndefined();
    expect(actual.targets).toEqual([]);
    expect(thrown(() => requireDeclared(ROOT, actual.discovery))).toBe(
      thrown(() => requireDeclared(ROOT, expected.discovery))
    );
  });

  it("raises native discovery's error for an inspected unit's malformed manifest", async () => {
    const files = {
      "package.json": json({ name: "root", workspaces: ["packages/*"] }),
      "packages/bad/index.ts": source,
      "packages/bad/package.json": '{ "name": "bad",',
    };
    const nativeError = thrown(() => native(files));
    expect(nativeError).toMatch(SYNTAX_ERROR);
    expect(await rejected(fromMap(files))).toBe(nativeError);
  });

  it("skips a gitignored unit's malformed manifest, which the shared program then raises as natively", async () => {
    const files = {
      ".gitignore": "packages/ignored/\n",
      "package.json": json({ name: "root", workspaces: ["packages/*"] }),
      "packages/ignored/index.ts": source,
      "packages/ignored/package.json": "{ not json",
      "packages/ok/package.json": json({ name: "@x/ok" }),
      "packages/ok/src/index.ts": source,
    };
    const root = disk.materialize(files);
    const discovery = discoverSemanticsUnits(root, DEFAULT_CONFIGURATION);
    expect(discovery.skipped).toEqual([
      { path: "packages/ignored", reason: "gitignored" },
    ]);

    const nativeError = thrown(() => createProject(root));
    expect(nativeError).toMatch(SYNTAX_ERROR);
    expect(await rejected(fromMap(files))).toBe(nativeError);
  });

  it("raises the native inventory's error for a malformed root manifest under pnpm", async () => {
    const files = {
      "package.json": "{ broken",
      "packages/ok/package.json": json({ name: "@x/ok" }),
      "packages/ok/src/index.ts": source,
      "pnpm-workspace.yaml": "packages:\n  - packages/*\n",
    };
    const root = disk.materialize(files);
    const discovery = requireDeclared(
      root,
      discoverSemanticsUnits(root, DEFAULT_CONFIGURATION)
    );
    const nativeError = thrown(() =>
      collectDependencyInventory(root, discovery)
    );
    expect(nativeError).toMatch(SYNTAX_ERROR);
    expect(await rejected(fromMap(files))).toBe(nativeError);
  });
});

describe("dependency graph over a file map", () => {
  const workspace = (lock?: string): Record<string, string> => ({
    "package.json": json({ name: "root", workspaces: ["packages/*"] }),
    "packages/app/package.json": json({
      dependencies: { "@x/lib": "workspace:*", alias: "npm:left-pad@1" },
      devDependencies: { "left-pad": "^1.3.0" },
      name: "@x/app",
      peerDependencies: { react: "^19.0.0", vue: "^3.0.0" },
      peerDependenciesMeta: { vue: { optional: true } },
    }),
    "packages/app/src/index.ts": source,
    "packages/lib/package.json": json({
      dependencies: { "left-pad": "^1.0.0" },
      name: "@x/lib",
      version: "0.1.0",
    }),
    "packages/lib/src/index.ts": source,
    ...(lock !== undefined && { "bun.lock": lock }),
  });

  const LOCK = `{
  "lockfileVersion": 1,
  "workspaces": {
    "": { "name": "root", },
    "packages/app": {
      "name": "@x/app",
      "dependencies": { "@x/lib": "workspace:*", "alias": "npm:left-pad@1" },
      "devDependencies": { "left-pad": "^1.2.0" },
      "peerDependencies": { "react": "^19.0.0", "vue": "^3.0.0" },
    },
    "packages/lib": { "name": "@x/lib", "dependencies": { "left-pad": "^1.0.0" } },
  },
  "packages": {
    "@x/app": ["@x/app@workspace:packages/app"],
    "@x/lib": ["@x/lib@workspace:packages/lib"],
    "alias": ["left-pad@1.0.0", "", {}, "sha512-a"],
    "left-pad": ["left-pad@1.3.0", "", { "dependencies": { "@scope/util": "^2" } }, "sha512-b"],
    "left-pad/@scope/util": ["@scope/util@2.0.0", "", {}, "sha512-c"],
    "react": ["react@19.0.0", "", { "peerDependencies": { "scheduler": "*" }, "optionalPeers": ["scheduler"] }, "sha512-d"],
    "broken": "not an entry",
  },
}
`;

  it.each([
    ["a resolvable lockfile with stale and unreadable entries", LOCK],
    ["no lockfile", undefined],
    ["a lockfile that does not parse", "{ this is not json"],
    [
      "an unsupported lockfile version",
      json({ lockfileVersion: 0, packages: {}, workspaces: {} }),
    ],
  ])("resolves %s as natively", async (_label, lock) => {
    const files = workspace(lock);
    const expected = native(files);
    const actual = await fromMap(files);
    expect(actual.inventory).toEqual(expected.inventory);
  });

  it("keeps the lock's resolution, issues and statuses", async () => {
    const graph = (await fromMap(workspace(LOCK))).inventory?.graph;
    expect(graph?.resolution.status).toBe("partial");
    expect(graph?.resolution.source).toBe("bun.lock");
    expect(graph?.resolution.issues).toEqual(
      expect.arrayContaining([
        "Unreadable lock entry: broken",
        "Manifest differs from bun.lock: @x/app devDependencies.left-pad",
      ])
    );
    const edge = (from: string, name: string) =>
      graph?.edges.find((item) => item.source === from && item.name === name);
    expect(edge("@x/app", "@x/lib")).toMatchObject({
      resolution: "resolved",
      target: "@x/lib",
    });
    expect(edge("@x/app", "vue")).toMatchObject({
      optional: true,
      resolution: "unresolved",
    });
    expect(edge("lock:left-pad", "@scope/util")).toMatchObject({
      resolution: "resolved",
      target: "lock:left-pad/@scope/util",
    });
    const unreadable = (await fromMap(workspace("{ this is not json")))
      .inventory?.graph?.resolution;
    expect(unreadable?.status).toBe("unavailable");
    expect(unreadable?.source).toBeUndefined();
    expect(unreadable?.issues[0]).toBe(
      "Unsupported or unreadable bun.lock; this reader supports text lockfileVersion 1."
    );
  });
});
