import { describe, expect, it } from "vitest";
import type {
  DependencyEdge,
  DependencyNode,
} from "../../src/lib/dependency-graph-types";
import type { DependencyInventory } from "../../src/lib/dependency-inventory-types";
import { deriveFoundations } from "../../src/web/layout/foundations";

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
