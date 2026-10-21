import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { datasetReader } from "../../src/lib/dataset";
import { resolveDependencyGraph } from "../../src/lib/dependency-graph";
import { collectDependencyInventory } from "../../src/lib/dependency-inventory";
import { verifyDependencyInventory } from "../../src/lib/dependency-inventory-schema";
import type { DependencyInventory } from "../../src/lib/dependency-inventory-types";
import { enrichDependencyUsage } from "../../src/lib/dependency-usage";
import type { PackageLocalImport } from "../../src/lib/package-local-types";
import {
  discoverSemanticsUnits,
  requireDeclared,
} from "../../src/lib/semantics-discover";
import { DEFAULT_CONFIGURATION } from "../../src/lib/spyglass-config";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { force: true, recursive: true });
  }
});
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "dependency-inventory-"));
  roots.push(root);
  writeFileSync(
    join(root, "package.json"),
    JSON.stringify({
      devDependencies: { tooling: "1.0.0" },
      name: "root",
      workspaces: ["packages/*"],
    })
  );
  const add = (
    name: string,
    manifest: Record<string, unknown> = {},
    source = true
  ) => {
    const path = `packages/${name}`;
    mkdirSync(join(root, path), { recursive: true });
    writeFileSync(
      join(root, path, "package.json"),
      JSON.stringify({ name, ...manifest })
    );
    if (source) {
      writeFileSync(join(root, path, "index.ts"), "export const item = 1;");
    }
  };
  const inventory = (exclude: string[] = []) =>
    collectDependencyInventory(
      root,
      requireDeclared(
        root,
        discoverSemanticsUnits(root, { ...DEFAULT_CONFIGURATION, exclude })
      )
    );
  const lock = (packages: Record<string, unknown>, data = inventory()) => {
    writeFileSync(
      join(root, "bun.lock"),
      JSON.stringify({
        lockfileVersion: 1,
        packages,
        workspaces: Object.fromEntries(
          data.packages.map((pkg) => [
            pkg.path,
            { name: pkg.name, ...pkg.declaredDependencies },
          ])
        ),
      })
    );
  };
  return { add, inventory, lock, root };
}
it("registers unsupported manifests and root tooling without leaking exclusions or ignores", () => {
  const f = fixture();
  f.add("app");
  f.add("config", { dependencies: { zod: "^4" } }, false);
  f.add("excluded");
  f.add("ignored");
  writeFileSync(join(f.root, ".gitignore"), "packages/ignored/\n");
  const inventory = f.inventory(["packages/excluded"]);
  expect(inventory.packages.map((pkg) => pkg.id)).toEqual([
    "app",
    "config",
    "workspace-root:",
  ]);
  expect(inventory.packages.find((pkg) => pkg.id === "config")).toMatchObject({
    analysis: "unsupported",
    declaredDependencies: { dependencies: { zod: "^4" } },
    role: "workspace",
  });
  expect(inventory.packages.find((pkg) => pkg.role === "root")).toMatchObject({
    declaredDependencies: { devDependencies: { tooling: "1.0.0" } },
    path: "",
  });
  expect(inventory.skipped).toEqual([
    { name: "excluded", path: "packages/excluded", reason: "excluded" },
    { name: "ignored", path: "packages/ignored", reason: "gitignored" },
  ]);
});
it("registers a standalone manifest without TypeScript", () => {
  const f = fixture();
  writeFileSync(
    join(f.root, "package.json"),
    JSON.stringify({ dependencies: { zod: "4.0.0" }, name: "plain-js" })
  );
  expect(f.inventory().packages).toMatchObject([
    { analysis: "unsupported", id: "plain-js", path: "", role: "workspace" },
  ]);
});
describe("saved resolution", () => {
  it("retains declarations without a lock and resolves only explicit workspace links", () => {
    const f = fixture();
    f.add("a", { dependencies: { b: "workspace:*", zod: "^4" } });
    f.add("b", {}, false);
    const graph = resolveDependencyGraph(f.root, f.inventory());
    expect(graph.resolution.status).toBe("unavailable");
    expect(graph.edges.find((edge) => edge.name === "b")).toMatchObject({
      resolution: "resolved",
      target: "b",
    });
    expect(graph.edges.find((edge) => edge.name === "zod")?.resolution).toBe(
      "unresolved"
    );
    expect(graph.nodes.every((node) => node.kind === "workspace")).toBe(true);
  });
  it.each(["{ nope", '{"lockfileVersion":2,"packages":{},"workspaces":{}}'])(
    "reports corrupt or unsupported locks: %s",
    (text) => {
      const f = fixture();
      f.add("a");
      writeFileSync(join(f.root, "bun.lock"), text);
      expect(
        resolveDependencyGraph(f.root, f.inventory()).resolution.status
      ).toBe("unavailable");
    }
  );
  it("resolves nested scoped versions, canonical npm aliases, cycles, and optional peers", () => {
    const f = fixture();
    f.add("a", {
      dependencies: { "@scope/parent": "1", alias: "npm:real@2" },
      peerDependencies: { absent: "^1" },
      peerDependenciesMeta: { absent: { optional: true } },
    });
    f.lock({
      "@scope/child": ["@scope/child@2.0.0", "", {}],
      "@scope/parent": [
        "@scope/parent@1.0.0",
        "",
        { dependencies: { "@scope/child": "1" } },
      ],
      "@scope/parent/@scope/child": [
        "@scope/child@1.0.0",
        "",
        {
          dependencies: { "@scope/parent": "1" },
          optionalDependencies: { optional: "1" },
          optionalPeers: ["peer"],
          peerDependencies: { peer: "1" },
        },
      ],
      a: ["a@workspace:packages/a"],
      alias: ["real@2.0.0", "", {}],
      tooling: ["tooling@1.0.0", "", {}],
    });
    const graph = resolveDependencyGraph(f.root, f.inventory());
    expect(
      graph.edges.find(
        (edge) =>
          edge.source === "lock:@scope/parent" && edge.name === "@scope/child"
      )?.target
    ).toBe("lock:@scope/parent/@scope/child");
    expect(
      graph.edges.find(
        (edge) =>
          edge.source === "lock:@scope/parent/@scope/child" &&
          edge.name === "@scope/parent"
      )?.target
    ).toBe("lock:@scope/parent");
    expect(graph.nodes.find((node) => node.id === "lock:alias")).toMatchObject({
      name: "real",
      version: "2.0.0",
    });
    expect(
      graph.edges
        .filter((edge) => ["optional", "peer", "absent"].includes(edge.name))
        .every((edge) => edge.optional && edge.resolution === "unresolved")
    ).toBe(true);
    expect(graph.resolution.status).toBe("partial");
  });
  it("does not bind a stale workspace name to the renamed package at its old path", () => {
    const f = fixture();
    f.add("a", { dependencies: { b: "workspace:*" } });
    f.add("b", { dependencies: { zod: "4" } });
    f.lock({
      b: ["b@workspace:packages/b"],
      tooling: ["tooling@1.0.0", "", {}],
      zod: ["zod@4.0.0", "", {}],
    });
    f.add("b", { dependencies: { zod: "4" }, name: "renamed" });
    const graph = resolveDependencyGraph(f.root, f.inventory());
    expect(graph.nodes.find((node) => node.id === "renamed")?.name).toBe(
      "renamed"
    );
    expect(
      graph.edges.find((edge) => edge.source === "a" && edge.name === "b")
    ).toMatchObject({ resolution: "unresolved" });
    expect(
      graph.edges.find((edge) => edge.source === "a" && edge.name === "b")
        ?.target
    ).toBeUndefined();
    expect(
      graph.edges.find(
        (edge) => edge.source === "renamed" && edge.name === "zod"
      )?.resolution
    ).toBe("unresolved");
    expect(graph.resolution.status).toBe("partial");
    expect(graph.resolution.issues).toContain(
      "Workspace identity differs from bun.lock: packages/b is renamed, locked as b"
    );
  });

  it("allows a workspace alias when the locked canonical name still matches its manifest", () => {
    const f = fixture();
    f.add("a", { dependencies: { alias: "workspace:b@*" } });
    f.add("b");
    f.lock({
      alias: ["b@workspace:packages/b"],
      tooling: ["tooling@1.0.0", "", {}],
    });
    const graph = resolveDependencyGraph(f.root, f.inventory());
    expect(graph.edges.find((edge) => edge.name === "alias")).toMatchObject({
      resolution: "resolved",
      target: "b",
    });
  });

  it("does not reuse old resolution for a changed manifest range", () => {
    const f = fixture();
    f.add("a", { dependencies: { zod: "^3" } });
    f.lock({ tooling: ["tooling@1.0.0", "", {}], zod: ["zod@3.0.0", "", {}] });
    f.add("a", { dependencies: { zod: "^4" } });
    const graph = resolveDependencyGraph(f.root, f.inventory());
    expect(graph.edges.find((edge) => edge.name === "zod")).toMatchObject({
      range: "^4",
      resolution: "unresolved",
      target: undefined,
    });
    expect(graph.resolution.issues).toContain(
      "Manifest differs from bun.lock: a dependencies.zod"
    );
  });
  it("reads JSONC, preserves dev/peer categories, and never revives excluded workspaces", () => {
    const f = fixture();
    f.add("a", {
      dependencies: { hidden: "workspace:*" },
      devDependencies: { zod: "^4" },
      peerDependencies: { zod: "^4" },
    });
    f.add("hidden");
    f.lock({
      hidden: ["hidden@workspace:packages/hidden"],
      tooling: ["tooling@1.0.0", "", {}],
      zod: ["zod@4.0.0", "", {}],
    });
    const text = readFileSync(join(f.root, "bun.lock"), "utf8");
    writeFileSync(
      join(f.root, "bun.lock"),
      `// saved resolution\n${text.slice(0, -1)},}`
    );
    const graph = resolveDependencyGraph(
      f.root,
      f.inventory(["packages/hidden"])
    );
    expect(graph.nodes.some((node) => node.id === "hidden")).toBe(false);
    expect(graph.edges.find((edge) => edge.name === "hidden")?.resolution).toBe(
      "unresolved"
    );
    expect(
      graph.edges.filter((edge) => edge.name === "zod").map((edge) => edge.kind)
    ).toEqual(["devDependencies", "peerDependencies"]);
  });
});
function site(
  specifier: string,
  sourceModule: string,
  typeOnly = false,
  scope: PackageLocalImport["scope"] = "external"
): PackageLocalImport {
  return {
    kind: typeOnly ? "type" : "named",
    scope,
    sourceModule,
    specifier,
    typeOnly,
  };
}
it("deduplicates imports, handles subpaths and aliases, and distinguishes no coverage from zero", () => {
  const f = fixture();
  f.add("a", {
    dependencies: { alias: "npm:real@2", internal: "1", unused: "1", zod: "4" },
  });
  f.add("b", { dependencies: { zod: "4" } });
  const inventory = f.inventory();
  inventory.graph = resolveDependencyGraph(f.root, inventory);
  const enriched = enrichDependencyUsage(
    inventory,
    new Map([
      [
        "a",
        {
          imports: [
            site("zod/v4", "a.ts"),
            site("zod", "a.ts"),
            site("zod", "a.ts", true),
            site("zod", "types.ts", true),
            site("alias/sub", "alias.ts"),
            site("node:fs", "a.ts"),
            site("internal", "a.ts", false, "internal"),
          ],
        },
      ],
    ])
  );
  expect(
    enriched.graph?.edges.find(
      (edge) => edge.source === "a" && edge.name === "zod"
    )?.usage
  ).toEqual({
    importingFiles: ["a.ts", "types.ts"],
    runtimeFiles: ["a.ts"],
    typeOnlyFiles: ["types.ts"],
  });
  expect(
    enriched.graph?.edges.find((edge) => edge.name === "alias")?.usage
      ?.importingFiles
  ).toEqual(["alias.ts"]);
  expect(
    enriched.graph?.edges.find((edge) => edge.name === "unused")?.usage
      ?.importingFiles
  ).toEqual([]);
  expect(
    enriched.graph?.edges.find((edge) => edge.name === "internal")?.usage
      ?.importingFiles
  ).toEqual([]);
  expect(
    enriched.graph?.edges.find((edge) => edge.source === "b")?.usage
  ).toBeUndefined();
  expect(enriched.usage).toEqual({
    analyzedPackages: ["a"],
    method: "static-imports",
    unavailablePackages: ["b", "workspace-root:"],
  });
  expect(inventory.usage).toBeUndefined();
});
describe("optional artifact", () => {
  const empty: DependencyInventory = {
    packages: [],
    schemaVersion: 1,
    skipped: [],
  };
  const reader = (value?: unknown, path = true) =>
    datasetReader(async (file) =>
      file === "manifest.json"
        ? {
            files: path ? { dependencyInventory: "inventory.json" } : {},
            schemaVersion: 5,
          }
        : value
    );
  it("reads old datasets and refuses missing advertised artifacts", async () => {
    await expect(
      reader(undefined, false).dependencyInventory()
    ).resolves.toBeUndefined();
    await expect(reader().dependencyInventory()).rejects.toThrow(
      "missing inventory.json"
    );
    await expect(reader(empty).dependencyInventory()).resolves.toEqual(empty);
  });
  it.each([
    null,
    {},
    { ...empty, schemaVersion: 2 },
    { ...empty, graph: { schemaVersion: 2 } },
  ])("rejects corrupt inventory %j", async (value) => {
    await expect(reader(value).dependencyInventory()).rejects.toThrow(
      "dependency inventory is unreadable"
    );
  });
  it("rejects dangling graph references", () => {
    expect(() =>
      verifyDependencyInventory({
        ...empty,
        graph: {
          edges: [
            {
              kind: "dependencies",
              name: "zod",
              range: "4",
              resolution: "resolved",
              source: "missing",
              target: "also-missing",
            },
          ],
          nodes: [],
          resolution: { issues: [], status: "complete" },
          schemaVersion: 1,
        },
      })
    ).toThrow("invalid graph references");
  });
});
