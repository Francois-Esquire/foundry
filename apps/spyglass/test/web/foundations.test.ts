import { describe, expect, it } from "vitest";
import type {
  DependencyEdge,
  DependencyNode,
} from "../../src/lib/dependency-graph-types";
import type { DependencyInventory } from "../../src/lib/dependency-inventory-types";
import {
  deriveFoundations,
  deriveInternalFoundations,
} from "../../src/lib/visualization/foundations";

const workspace = (id: string): DependencyNode => ({
  id,
  kind: "workspace",
  name: id,
});
const external = (
  id: string,
  name = id,
  version = "1.0.0"
): DependencyNode => ({ id, kind: "external", name, version });
const edge = (
  source: string,
  target: string,
  kind: DependencyEdge["kind"] = "dependencies"
): DependencyEdge => ({
  kind,
  name: target,
  range: "*",
  resolution: "resolved",
  source,
  target,
});
function inventory(
  nodes: DependencyNode[],
  edges: DependencyEdge[]
): DependencyInventory {
  return {
    graph: {
      edges,
      nodes,
      resolution: { issues: [], status: "complete" },
      schemaVersion: 1,
    },
    packages: nodes
      .filter((node) => node.kind === "workspace")
      .map((node) => ({
        analysis: "available",
        declaredDependencies: {},
        id: node.id,
        name: node.name,
        path: node.id,
        role: "workspace",
      })),
    schemaVersion: 1,
    skipped: [],
  };
}

describe("shared dependency foundations", () => {
  it("deduplicates diamond and cyclic transitive paths using the shortest consumer distance", () => {
    const data = inventory(
      [
        workspace("a"),
        workspace("b"),
        external("left"),
        external("right"),
        external("z"),
      ],
      [
        edge("a", "left"),
        edge("a", "right"),
        edge("left", "z"),
        edge("right", "z"),
        edge("z", "left"),
        edge("b", "z"),
      ]
    );
    const z = deriveFoundations(data, ["a", "b", "a"]).find(
      (foundation) => foundation.name === "z"
    );
    expect(z?.members).toEqual([
      { direct: false, distance: 2, territoryId: "a", weight: 0.45 },
      { direct: true, distance: 1, territoryId: "b", weight: 1 },
    ]);
    expect(z?.prominence).toBe(2);
  });
  it("includes workspace runtime chains but excludes development and peer chains", () => {
    const data = inventory(
      [
        workspace("a"),
        workspace("b"),
        external("runtime"),
        external("dev"),
        external("peer"),
        external("optional"),
      ],
      [
        edge("a", "b"),
        edge("b", "runtime"),
        edge("a", "dev", "devDependencies"),
        edge("b", "dev", "devDependencies"),
        edge("a", "peer", "peerDependencies"),
        edge("b", "peer", "peerDependencies"),
        edge("a", "optional", "optionalDependencies"),
        edge("b", "optional", "optionalDependencies"),
      ]
    );
    expect(
      deriveFoundations(data, ["a", "b"]).map((foundation) => foundation.name)
    ).toEqual(["optional", "runtime"]);
  });
  it("groups resolved aliases and versions by external name while preserving concrete versions", () => {
    const data = inventory(
      [
        workspace("a"),
        workspace("b"),
        external("z3", "zod", "3.0.0"),
        external("z4", "zod", "4.0.0"),
      ],
      [
        { ...edge("a", "z3"), name: "zod-alias" },
        edge("a", "z4"),
        edge("b", "z4"),
      ]
    );
    const foundations = deriveFoundations(data, ["a", "b"]);
    expect(foundations).toHaveLength(1);
    expect(foundations[0]).toMatchObject({
      name: "zod",
      prominence: 2,
      versions: ["3.0.0", "4.0.0"],
    });
    expect(foundations[0]?.members).toHaveLength(2);
  });
  it("retains unresolved external declarations without inventing versions or workspace foundations", () => {
    const data = inventory(
      [workspace("a"), workspace("b"), workspace("core")],
      [
        {
          ...edge("a", "unknown"),
          range: "^7",
          resolution: "unresolved",
          target: undefined,
        },
        {
          ...edge("b", "unknown"),
          range: "^7",
          resolution: "unresolved",
          target: undefined,
        },
        { ...edge("a", "core"), resolution: "unresolved", target: undefined },
        { ...edge("b", "core"), resolution: "unresolved", target: undefined },
      ]
    );
    expect(deriveFoundations(data, ["a", "b"])).toMatchObject([
      { name: "unknown", prominence: 2, versions: [] },
    ]);
  });
  it("never turns excluded workspaces or unresolved workspace protocols into external foundations", () => {
    const unresolved = (
      source: string,
      name: string,
      range: string
    ): DependencyEdge => ({
      ...edge(source, name),
      range,
      resolution: "unresolved",
      target: undefined,
    });
    const data = inventory(
      [workspace("a"), workspace("b")],
      [
        unresolved("a", "excluded", "^1"),
        unresolved("b", "excluded", "^1"),
        unresolved("a", "unregistered", "workspace:*"),
        unresolved("b", "unregistered", "workspace:*"),
        unresolved("a", "external", "^1"),
        unresolved("b", "external", "^1"),
      ]
    );
    data.skipped = [{ name: "excluded", path: "excluded", reason: "excluded" }];
    expect(deriveFoundations(data, ["a", "b"]).map(({ name }) => name)).toEqual(
      ["external"]
    );
  });
  it("has deterministic membership despite reordered graph data and excludes unique dependencies", () => {
    const data = inventory(
      [workspace("a"), workspace("b"), external("z"), external("unique")],
      [edge("a", "z"), edge("b", "z"), edge("a", "unique")]
    );
    const original = deriveFoundations(data, ["b", "a"]);
    data.graph?.nodes.reverse();
    data.graph?.edges.reverse();
    expect(deriveFoundations(data, ["a", "b"])).toEqual(original);
    expect(original.map((foundation) => foundation.name)).toEqual(["z"]);
    expect(
      deriveFoundations({ ...data, graph: undefined }, ["a", "b"])
    ).toEqual([]);
  });
  it("unions observed alias imports without inheriting another package's usage", () => {
    const data = inventory(
      [
        workspace("a"),
        workspace("b"),
        workspace("c"),
        external("z1", "zod"),
        external("z2", "zod", "2.0.0"),
      ],
      [
        {
          ...edge("a", "z1"),
          usage: {
            importingFiles: ["mixed.ts", "types.ts"],
            runtimeFiles: [],
            typeOnlyFiles: ["mixed.ts", "types.ts"],
          },
        },
        {
          ...edge("a", "z2"),
          usage: {
            importingFiles: ["mixed.ts", "value.ts"],
            runtimeFiles: ["mixed.ts", "value.ts"],
            typeOnlyFiles: [],
          },
        },
        {
          ...edge("b", "z1"),
          usage: { importingFiles: [], runtimeFiles: [], typeOnlyFiles: [] },
        },
        {
          ...edge("c", "a"),
          usage: {
            importingFiles: ["consumer.ts"],
            runtimeFiles: ["consumer.ts"],
            typeOnlyFiles: [],
          },
        },
      ]
    );
    const [field] = deriveFoundations(data, ["a", "b", "c"]);
    expect(field?.members[0]?.usage).toEqual({
      importingFiles: ["mixed.ts", "types.ts", "value.ts"],
      runtimeFiles: ["mixed.ts", "value.ts"],
      typeOnlyFiles: ["types.ts"],
    });
    expect(field?.members[0]?.weight).toBeGreaterThan(1);
    expect(field?.members[0]?.weight).toBeLessThanOrEqual(1.25);
    expect(field?.members[1]).toMatchObject({
      usage: { importingFiles: [], runtimeFiles: [], typeOnlyFiles: [] },
      weight: 1,
    });
    expect(field?.members[2]).toMatchObject({ distance: 2, weight: 0.45 });
    expect(field?.members[2]?.usage).toBeUndefined();
  });
  it("caps observed usage refinement and gives type-only evidence less influence", () => {
    const many = Array.from({ length: 1000 }, (_, index) => `${index}.ts`);
    const data = inventory(
      [workspace("a"), workspace("b"), external("z")],
      [
        {
          ...edge("a", "z"),
          usage: {
            importingFiles: many,
            runtimeFiles: many,
            typeOnlyFiles: [],
          },
        },
        {
          ...edge("b", "z"),
          usage: {
            importingFiles: many,
            runtimeFiles: [],
            typeOnlyFiles: many,
          },
        },
      ]
    );
    const members = deriveFoundations(data, ["a", "b"])[0]?.members;
    expect(members?.[0]?.weight).toBeLessThanOrEqual(1.25);
    expect(members?.[1]?.weight).toBeLessThan(1.1);
    expect(members?.[0]?.weight).toBeGreaterThan(members?.[1]?.weight ?? 0);
  });
});

describe("internal workspace foundations", () => {
  it("keeps a package relied upon by many apart from shared third-party code", () => {
    const data = inventory(
      [
        workspace("lib"),
        workspace("core"),
        workspace("a"),
        workspace("b"),
        workspace("c"),
        external("zod"),
      ],
      [
        edge("lib", "core"),
        edge("a", "lib"),
        edge("b", "lib"),
        edge("c", "b"),
        edge("a", "zod"),
        edge("b", "zod"),
        edge("c", "lib", "devDependencies"),
        edge("a", "c", "peerDependencies"),
      ]
    );
    const internal = deriveInternalFoundations(data, [
      "a",
      "b",
      "c",
      "core",
      "lib",
    ]);
    expect(internal.map(({ id }) => id)).toEqual([
      "workspace:b",
      "workspace:core",
      "workspace:lib",
    ]);
    const lib = internal.find(({ supplierId }) => supplierId === "lib");
    // `c` reaches `lib` at runtime only through `b`; its devDependency is not structure.
    expect(lib?.members).toEqual([
      { direct: true, distance: 1, territoryId: "a", weight: 1 },
      { direct: true, distance: 1, territoryId: "b", weight: 1 },
      { direct: false, distance: 2, territoryId: "c", weight: 0.45 },
    ]);
    expect(lib?.prominence).toBe(3);
    const core = internal.find(({ supplierId }) => supplierId === "core");
    expect(core?.members.map(({ territoryId }) => territoryId)).toEqual([
      "a",
      "b",
      "c",
      "lib",
    ]);
    // Third-party foundations never include a workspace, and vice versa.
    expect(
      deriveFoundations(data, ["a", "b", "c", "core", "lib"]).map(
        ({ name }) => name
      )
    ).toEqual(["zod"]);
    expect(internal.every(({ id }) => !id.includes("zod"))).toBe(true);
  });
  it("follows unresolved workspace declarations by name and ignores packages off the map", () => {
    const data = inventory(
      [workspace("lib"), workspace("a"), workspace("hidden")],
      [
        {
          kind: "dependencies",
          name: "lib",
          range: "workspace:*",
          resolution: "unresolved",
          source: "a",
        },
        edge("hidden", "lib"),
        edge("lib", "lib"),
      ]
    );
    expect(deriveInternalFoundations(data, ["lib", "a"])).toEqual([
      {
        id: "workspace:lib",
        members: [{ direct: true, distance: 1, territoryId: "a", weight: 1 }],
        prominence: 1,
        supplierId: "lib",
      },
    ]);
    expect(
      deriveInternalFoundations({ ...data, graph: undefined }, ["lib", "a"])
    ).toEqual([]);
  });
  it("is deterministic regardless of graph order", () => {
    const nodes = [workspace("lib"), workspace("a"), workspace("b")];
    const edges = [edge("a", "lib"), edge("b", "lib"), edge("b", "a")];
    expect(
      deriveInternalFoundations(inventory(nodes, edges), ["a", "b", "lib"])
    ).toEqual(
      deriveInternalFoundations(
        inventory([...nodes].reverse(), [...edges].reverse()),
        ["lib", "b", "a"]
      )
    );
  });
});
