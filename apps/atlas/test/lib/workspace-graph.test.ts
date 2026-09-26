import { describe, expect, it } from "vitest";

import type { ModuleRole } from "../../src/lib/types";
import { analyzeWorkspaceGraph } from "../../src/lib/workspace-graph";
import type { WorkspaceGraphAnalysis } from "../../src/lib/workspace-graph-types";
import type { WorkspaceReport } from "../../src/lib/workspace-types";
import { WORKSPACE_SCHEMA_VERSION } from "../../src/lib/workspace-types";

interface Spec {
  anchored?: string[];
  /** Unrelated indexes, to prove they do not leak into graph facts. */
  concepts?: number;
  /** `A→B` or `A→B:n` (module edges, default 1). */
  edges?: string[];
  findings?: number;
  /** Packages without a report; makes coverage partial. */
  missing?: string[];
  /** `A/a→B/x`; the package is the path's first segment. */
  moduleEdges?: string[];
  moduleRoles?: Record<string, ModuleRole["kind"]>;
  /** Extra packages beyond edge endpoints. */
  packages?: string[];
}

function parse(edge: string): { from: string; to: string; count: number } {
  const [pair, count] = edge.split(":");
  const [from, to] = (pair ?? "").split("→");
  return {
    count: count === undefined ? 1 : Number(count),
    from: from ?? "",
    to: to ?? "",
  };
}

function packageOfModule(module: string): string {
  return module.split("/")[0] ?? module;
}

function workspace(spec: Spec): WorkspaceReport {
  const edges = (spec.edges ?? []).map(parse);
  const moduleEdges = (spec.moduleEdges ?? []).map(parse);
  const packageIds = [
    ...new Set([
      ...(spec.packages ?? []),
      ...edges.flatMap((e) => [e.from, e.to]),
      ...moduleEdges.flatMap((e) => [
        packageOfModule(e.from),
        packageOfModule(e.to),
      ]),
    ]),
  ].sort();
  const missing = new Set(spec.missing ?? []);
  const anchored = new Set(spec.anchored ?? []);
  const moduleIds = [
    ...new Set(moduleEdges.flatMap((e) => [e.from, e.to])),
  ].sort();
  const partial = {
    architecture: {
      packages: [],
      recentering: {
        findings: Array.from({ length: spec.findings ?? 0 }, (_, i) => ({
          id: `f${i}`,
        })),
        impacts: [],
        reviews: [],
        scenarios: [],
      },
    },
    boundaries: {
      boundaries: edges.map((e) => ({
        from: e.from,
        id: `${e.from}→${e.to}`,
        importSites: e.count * 2,
        moduleEdges: e.count,
        symbols: {
          distinct: e.count,
          packagePublic: 10,
          references: e.count * 5,
        },
        to: e.to,
      })),
    },
    concepts: {
      byPackage: {},
      concepts: Array.from({ length: spec.concepts ?? 0 }, (_, i) => ({
        id: `c${i}`,
      })),
      overlaps: [],
    },
    evolution: {
      churn: [],
      couplings: [],
      hotspots: [],
      packageCouplings: [],
      radius: [],
    },
    graph: {
      dependencyEdges: edges.map((e) => ({
        from: e.from,
        id: `${e.from}→${e.to}`,
        moduleEdges: e.count,
        provenance: { observedBy: [e.from, e.to].sort() },
        to: e.to,
        verified: !(missing.has(e.from) || missing.has(e.to)),
      })),
      moduleEdges: moduleEdges.map((e) => ({
        from: e.from,
        fromPackage: packageOfModule(e.from),
        id: `${e.from}→${e.to}`,
        provenance: { observedBy: [packageOfModule(e.to)] },
        to: e.to,
        toPackage: packageOfModule(e.to),
      })),
      modules: moduleIds.map((id) => {
        const role = spec.moduleRoles?.[id];
        return {
          id,
          package: packageOfModule(id),
          ...(role !== undefined && {
            role: {
              entrypoint: role === "aggregator",
              kind: role,
              ownDeclarations: role === "aggregator" ? 0 : 3,
              reExports: role === "aggregator" ? 3 : 0,
            },
          }),
          provenance: { observedBy: [packageOfModule(id)] },
        };
      }),
      packages: packageIds.map((id) => ({
        analyzed: !missing.has(id),
        anchored: anchored.has(id),
        package: id,
        provenance: { observedBy: [id] },
      })),
    },
    ingestion: {
      conflicts: [],
      coverage: {
        complete: missing.size === 0,
        missingPackages: [...missing].sort(),
        packagesAnalyzed: packageIds.length - missing.size,
        packagesKnown: packageIds.length,
        population: packageIds.length,
      },
      diagnostics: [],
    },
    packages: {
      packages: packageIds.map((id) => ({
        analyzed: !missing.has(id),
        anchored: anchored.has(id),
        id,
        name: id,
        provenance: { observedBy: [id] },
      })),
    },
    sources: [],
    workspace: {
      packageCount: packageIds.length,
      reportCount: packageIds.length - missing.size,
    },
    workspaceSchemaVersion: WORKSPACE_SCHEMA_VERSION,
  };
  return partial as unknown as WorkspaceReport;
}

function pkg(analysis: WorkspaceGraphAnalysis, id: string) {
  const found = analysis.packages.find((p) => p.package === id);
  if (found === undefined) {
    throw new Error(`no package ${id}`);
  }
  return found;
}

function edge(analysis: WorkspaceGraphAnalysis, id: string) {
  const found = analysis.edges.find((e) => e.id === id);
  if (found === undefined) {
    throw new Error(`no edge ${id}`);
  }
  return found;
}

describe("package graph metrics", () => {
  const analysis = analyzeWorkspaceGraph(
    workspace({ edges: ["A→B", "A→C", "B→C"] })
  );

  it("computes fan-in, fan-out, transitive reach, depth, and layer exactly", () => {
    expect(pkg(analysis, "A")).toMatchObject({
      cycle: false,
      depth: { downstream: 0, upstream: 2 },
      direct: { fanIn: 0, fanOut: 2 },
      layer: 2,
      reach: { dependencyShare: 1, dependentShare: 0 },
      role: "source",
      transitive: { dependencies: 2, dependents: 0 },
    });
    expect(pkg(analysis, "B")).toMatchObject({
      depth: { downstream: 1, upstream: 1 },
      direct: { fanIn: 1, fanOut: 1 },
      layer: 1,
      role: "intermediate",
      transitive: { dependencies: 1, dependents: 1 },
    });
    expect(pkg(analysis, "C")).toMatchObject({
      depth: { downstream: 2, upstream: 0 },
      direct: { fanIn: 2, fanOut: 0 },
      layer: 0,
      reach: { dependencyShare: 0, dependentShare: 1 },
      role: "sink",
      transitive: { dependencies: 0, dependents: 2 },
    });
  });

  it("summarizes topology and reachability", () => {
    expect(analysis.topology).toMatchObject({
      connectedComponents: 1,
      packageDensity: 0.5,
      packageEdges: 3,
      packageIsolated: [],
      packageNodes: 3,
      packageSinks: ["C"],
      packageSources: ["A"],
    });
    expect(analysis.reachability).toMatchObject({
      longestPackageChains: [["A", "B", "C"]],
      packagePairsReachable: 3,
      packagePairsUnreachable: 3,
    });
    expect(analysis.certainty).toBe("complete");
    expect(analysis.cautions).toEqual([]);
  });

  it("carries boundary weights on edges without combining them", () => {
    expect(edge(analysis, "A→B").weights).toEqual({
      distinctSymbols: 1,
      importSites: 2,
      moduleEdges: 1,
      references: 5,
    });
  });
});

describe("strongly connected components", () => {
  const analysis = analyzeWorkspaceGraph(
    workspace({ edges: ["A→B", "B→C", "C→A", "C→D"] })
  );

  it("finds the cycle and keeps D outside it", () => {
    expect(analysis.cycles.packageStrongComponents).toEqual([
      { id: "A", nodes: ["A", "B", "C"], size: 3 },
    ]);
    expect(analysis.cycles.packageCycles).toBe(1);
    expect(pkg(analysis, "A").cycle).toBe(true);
    expect(pkg(analysis, "A").strongComponent).toBe("A");
    expect(pkg(analysis, "D").cycle).toBe(false);
    expect(pkg(analysis, "D").strongComponent).toBeNull();
  });

  it("condenses the cycle to one layer unit and one chain node", () => {
    expect(pkg(analysis, "A").layer).toBe(1);
    expect(pkg(analysis, "B").layer).toBe(1);
    expect(pkg(analysis, "C").layer).toBe(1);
    expect(pkg(analysis, "D").layer).toBe(0);
    expect(analysis.layers.packageLayers).toEqual([
      { index: 0, nodes: ["D"] },
      { index: 1, nodes: ["A", "B", "C"] },
    ]);
    expect(analysis.reachability.longestPackageChains).toEqual([
      ["[A|B|C]", "D"],
    ]);
    expect(pkg(analysis, "A").transitive).toEqual({
      dependencies: 3,
      dependents: 2,
    });
  });
});

describe("layers", () => {
  it("places a known DAG sink-first", () => {
    const analysis = analyzeWorkspaceGraph(
      workspace({ edges: ["A→B", "A→C", "B→D", "C→D", "D→E"] })
    );
    expect(analysis.layers.packageLayers).toEqual([
      { index: 0, nodes: ["E"] },
      { index: 1, nodes: ["D"] },
      { index: 2, nodes: ["B", "C"] },
      { index: 3, nodes: ["A"] },
    ]);
    expect(analysis.layers.maxPackageDepth).toBe(3);
    expect(analysis.reachability.longestPackageChains).toEqual([
      ["A", "B", "D", "E"],
      ["A", "C", "D", "E"],
    ]);
  });
});

describe("components and roles", () => {
  it("reports two independent regions with no cross reachability", () => {
    const analysis = analyzeWorkspaceGraph(
      workspace({ edges: ["A→B", "C→D"], packages: ["E"] })
    );
    expect(analysis.topology.connectedComponents).toBe(3);
    expect(analysis.topology.packageComponents).toEqual([
      { id: "A", nodes: ["A", "B"], size: 2 },
      { id: "C", nodes: ["C", "D"], size: 2 },
      { id: "E", nodes: ["E"], size: 1 },
    ]);
    expect(analysis.reachability.packagePairsReachable).toBe(2);
    expect(pkg(analysis, "A").component).toBe("A");
    expect(pkg(analysis, "D").component).toBe("C");
  });

  it("assigns source, sink, isolated, and intermediate descriptively", () => {
    const analysis = analyzeWorkspaceGraph(
      workspace({ edges: ["A→B", "B→C"], packages: ["Z"] })
    );
    expect(analysis.packages.map((p) => [p.package, p.role])).toEqual([
      ["A", "source"],
      ["B", "intermediate"],
      ["C", "sink"],
      ["Z", "isolated"],
    ]);
    expect(analysis.topology.packageIsolated).toEqual(["Z"]);
  });
});

describe("bridges and seams", () => {
  it("identifies the articulation package", () => {
    const analysis = analyzeWorkspaceGraph(
      workspace({ edges: ["A→B", "B→C", "B→D", "C→D"] })
    );
    expect(analysis.topology.articulationPackages).toEqual(["B"]);
    expect(pkg(analysis, "B").articulation).toBe(true);
    expect(pkg(analysis, "C").articulation).toBe(false);
  });

  it("names a weak bridge between two regions as a seam with component evidence", () => {
    const analysis = analyzeWorkspaceGraph(
      workspace({ edges: ["A→B", "B→C", "C→D"] })
    );
    const seam = analysis.seams.find((s) => s.id === "B→C");
    expect(seam).toMatchObject({
      alternativePaths: 0,
      anchored: [],
      boundary: "B→C",
      downstreamPackages: 2,
      from: "B",
      severedPairs: 3,
      to: "C",
      upstreamPackages: 2,
      weakBridge: true,
    });
    expect(seam?.evidence.map((e) => e.kind)).toEqual([
      "dependency-edge",
      "reachability",
      "shortest-path",
      "component",
    ]);
    expect(edge(analysis, "B→C").separates).toEqual({ from: 2, to: 2 });
    expect(analysis.seams[0]?.id).toBe("B→C");
  });

  it("does not call redundant edges seams when an alternative path exists", () => {
    const analysis = analyzeWorkspaceGraph(
      workspace({ edges: ["A→B", "B→D", "A→C", "C→D"] })
    );
    expect(edge(analysis, "B→D")).toMatchObject({
      severedPairs: 0,
      weakBridge: false,
    });
    expect(edge(analysis, "A→B")).toMatchObject({ severedPairs: 0 });
    expect(analysis.seams).toEqual([]);
    expect(pkg(analysis, "B").betweenness).toBeCloseTo(1 / 12);
    expect(pkg(analysis, "C").betweenness).toBeCloseTo(1 / 12);
  });

  it("does not treat a pendant edge as a seam", () => {
    const analysis = analyzeWorkspaceGraph(
      workspace({ edges: ["A→B", "A→C", "B→C"] })
    );
    expect(analysis.seams).toEqual([]);
  });

  it("ranks betweenness instead of forcing a bridge role", () => {
    const analysis = analyzeWorkspaceGraph(
      workspace({ edges: ["A→B", "B→C", "C→D"] })
    );
    expect(analysis.centers.bridgePackages).toEqual([
      { id: "B", value: 2 / 6 },
      { id: "C", value: 2 / 6 },
    ]);
    expect(
      analysis.packages.every((p) =>
        ["source", "sink", "intermediate", "isolated"].includes(p.role)
      )
    ).toBe(true);
  });
});

describe("corridors", () => {
  it("finds segments shared by several shortest routes", () => {
    const analysis = analyzeWorkspaceGraph(
      workspace({ edges: ["S1→B", "S2→B", "B→C", "C→T1", "C→T2"] })
    );
    // A pair whose whole route is the segment counts: (B, T1) supports B→C→T1.
    expect(analysis.corridors.map((c) => [c.id, c.support])).toEqual([
      ["B→C→T1", 3],
      ["B→C→T2", 3],
      ["S1→B→C", 3],
      ["S2→B→C", 3],
    ]);
    const corridor = analysis.corridors.find((c) => c.id === "S1→B→C");
    expect(corridor).toMatchObject({
      destinationPackages: ["C", "T1", "T2"],
      length: 2,
      packages: ["S1", "B", "C"],
      sourcePackages: ["S1"],
    });
    expect(corridor?.evidence).toEqual([
      { entities: ["S1", "C"], kind: "shortest-path", value: 2 },
      { entities: ["S1", "T1"], kind: "shortest-path", value: 2 },
      { entities: ["S1", "T2"], kind: "shortest-path", value: 2 },
    ]);
  });

  it("keeps only segments not contained in a longer qualifying one", () => {
    const analysis = analyzeWorkspaceGraph(
      workspace({ edges: ["S1→A", "S2→A", "A→B", "B→C", "C→T"] })
    );
    expect(analysis.corridors.map((c) => [c.id, c.support])).toEqual([
      ["A→B→C→T", 3],
      ["S1→A→B→C", 2],
      ["S2→A→B→C", 2],
    ]);
  });
});

describe("anchors", () => {
  it("attaches anchor context without changing any metric", () => {
    const plain = analyzeWorkspaceGraph(
      workspace({ edges: ["A→B", "B→C", "C→D"] })
    );
    const anchored = analyzeWorkspaceGraph(
      workspace({ anchored: ["B"], edges: ["A→B", "B→C", "C→D"] })
    );
    const strip = (analysis: WorkspaceGraphAnalysis) =>
      JSON.stringify({
        ...analysis,
        packages: analysis.packages.map((p) => ({ ...p, anchored: false })),
        seams: analysis.seams.map((s) => ({
          ...s,
          anchored: [],
          evidence: s.evidence.filter((e) => e.kind !== "anchor"),
        })),
      });
    expect(strip(anchored)).toBe(strip(plain));
    expect(pkg(anchored, "B").anchored).toBe(true);
    const seam = anchored.seams.find((s) => s.id === "B→C");
    expect(seam?.anchored).toEqual(["B"]);
    expect(seam?.evidence).toContainEqual({ entities: ["B"], kind: "anchor" });
  });
});

describe("module graph", () => {
  it("surfaces a high-fan-in aggregator with its role retained", () => {
    const analysis = analyzeWorkspaceGraph(
      workspace({
        edges: ["A→B"],
        moduleEdges: ["A/a→B/index", "A/b→B/index", "A/c→B/index"],
        moduleRoles: { "B/index": "aggregator" },
      })
    );
    expect(analysis.centers.highFanInModules[0]).toMatchObject({
      id: "B/index",
      role: { kind: "aggregator" },
      value: 3,
    });
    expect(analysis.modules.find((m) => m.module === "B/index")).toMatchObject({
      direct: { fanIn: 3, fanOut: 0 },
      package: "B",
      role: { kind: "aggregator" },
    });
    expect(analysis.cautions.map((c) => c.kind)).toEqual([
      "module-graph-cross-package-only",
    ]);
  });

  it("preserves module depth hidden by a shallow package graph", () => {
    const analysis = analyzeWorkspaceGraph(
      workspace({
        edges: ["A→B"],
        moduleEdges: ["A/a→B/x", "B/x→B/y", "B/y→B/z"],
      })
    );
    expect(analysis.layers.maxPackageDepth).toBe(1);
    expect(analysis.layers.maxModuleDepth).toBe(3);
    expect(analysis.reachability.longestModuleChains).toEqual([
      ["A/a", "B/x", "B/y", "B/z"],
    ]);
    expect(analysis.topology.moduleSources).toEqual(["A/a"]);
    expect(analysis.topology.moduleSinks).toEqual(["B/z"]);
    expect(analysis.cautions).toEqual([]);
  });
});

describe("coverage and edges", () => {
  it("marks partial coverage and cautions instead of claiming a complete topology", () => {
    const analysis = analyzeWorkspaceGraph(
      workspace({ edges: ["A→B", "B→C"], missing: ["C"] })
    );
    expect(analysis.certainty).toBe("partial");
    expect(analysis.cautions).toEqual([
      expect.objectContaining({ entities: ["C"], kind: "partial-coverage" }),
    ]);
    expect(pkg(analysis, "C")).toMatchObject({
      analyzed: false,
      direct: { fanIn: 1, fanOut: 0 },
    });
  });

  it("excludes usage-only dependency edges from the graph", () => {
    const analysis = analyzeWorkspaceGraph(
      workspace({ edges: ["A→B", "B→C", "A→C:0"] })
    );
    expect(analysis.topology.usageOnlyEdges).toEqual(["A→C"]);
    expect(analysis.edges.map((e) => e.id)).toEqual(["A→B", "B→C"]);
    expect(pkg(analysis, "A").direct.fanOut).toBe(1);
    expect(analysis.cautions).toEqual([
      expect.objectContaining({ entities: ["A→C"], kind: "usage-only-edges" }),
    ]);
  });
});

describe("determinism and separation", () => {
  const spec: Spec = {
    anchored: ["D"],
    edges: ["A→B", "B→C", "C→A", "C→D", "E→D", "E→B"],
    moduleEdges: ["A/a→B/x", "B/x→C/y", "E/e→D/d"],
  };

  it("is byte-stable under reordered canonical collections", () => {
    const forward = workspace(spec);
    const shuffled = workspace(spec);
    shuffled.graph.packages.reverse();
    shuffled.graph.dependencyEdges.reverse();
    shuffled.graph.modules.reverse();
    shuffled.graph.moduleEdges.reverse();
    shuffled.boundaries.boundaries.reverse();
    expect(JSON.stringify(analyzeWorkspaceGraph(shuffled))).toBe(
      JSON.stringify(analyzeWorkspaceGraph(forward))
    );
  });

  it("ignores concept and V8 indexes entirely", () => {
    const bare = analyzeWorkspaceGraph(workspace(spec));
    const loaded = analyzeWorkspaceGraph(
      workspace({ ...spec, concepts: 40, findings: 7 })
    );
    expect(JSON.stringify(loaded)).toBe(JSON.stringify(bare));
  });

  it("round-trips through JSON and carries no score", () => {
    const analysis = analyzeWorkspaceGraph(workspace(spec));
    const json = JSON.stringify(analysis);
    expect(JSON.parse(json)).toEqual(analysis);
    expect(json).not.toMatch(/score/i);
    expect(json).not.toMatch(/importance/i);
    expect(json).not.toMatch(/health/i);
  });
});
