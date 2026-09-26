import { describe, expect, it } from "vitest";
import { renderWorkspaceReport } from "../../src/lib/report-workspace";
import type { SurfaceReport } from "../../src/lib/types";
import { ingestWorkspaceReports } from "../../src/lib/workspace-ingest";

// Synthetic package reports carrying only the sections workspace ingestion
// reads. The builder fills every required section with an empty-but-valid
// shape, so each test states just the facts it is about.

interface Edge {
  distinct?: number;
  edges: [string, string][];
  importSites: number;
  package: string;
}

interface Seed {
  file: string;
  id: string;
  name: string;
  status?: "candidate" | "protected" | "insufficient-evidence";
}

interface Overlap {
  assignability?: "left-to-right" | "right-to-left" | "both" | "neither";
  conversions?: { function: string; from: string; to: string; file: string }[];
  left: {
    id: string;
    name: string;
    package: string;
    file: string;
    inTarget: boolean;
  };
  leftOnly?: string[];
  right: {
    id: string;
    name: string;
    package: string;
    file: string;
    inTarget: boolean;
  };
  rightOnly?: string[];
}

interface Coupling {
  left: string;
  leftCommits: number;
  leftConditional: number;
  leftPackage: string;
  right: string;
  rightCommits: number;
  rightConditional: number;
  rightPackage: string;
  staticRelation: "left-to-right" | "right-to-left" | "bidirectional" | "none";
}

interface Options {
  churn?: { file: string; commits: number }[];
  couplings?: Coupling[];
  findings?: { id: string; conceptId: string }[];
  incoming?: Edge[];
  outgoing?: Edge[];
  overlaps?: Overlap[];
  /** Package the re-centering concept is declared in; defaults to the report's own. */
  owner?: string;
  path?: string;
  policyVersion?: number;
  population?: number;
  reviews?: { findingId: string; conceptId: string; scenarioIds: string[] }[];
  scenarios?: { id: string; findingId: string; conceptId: string }[];
  schemaVersion?: number;
  seeds?: Seed[];
  window?: { since: string; analyzedAt: string; windowDays: number };
}

function identity(
  id: string,
  name: string,
  pkg: string,
  file: string,
  inTarget: boolean
) {
  return { file, id, inTarget, kind: "interface", name, package: pkg };
}

function interaction(
  from: string,
  to: string,
  edge: Edge,
  destination: boolean
) {
  return {
    breadth: { destinationModules: 1, sourceModules: 1 },
    concentration: { destinationModuleShare: 1, sourceModuleShare: 1 },
    destinationModules: [],
    from,
    importSites: edge.importSites,
    moduleEdges: edge.edges.length,
    sourceModules: [],
    surfaceCoverage: destination ? 0.5 : null,
    symbols: {
      distinct: edge.distinct ?? 1,
      packagePublic: destination ? (edge.distinct ?? 1) : null,
      references: destination ? edge.importSites * 2 : null,
      referencesPerSymbol: null,
    },
    to,
    usage: {
      bothSymbols: 0,
      namespace: "value",
      typeOnlySymbols: 0,
      valueOnlySymbols: edge.distinct ?? 1,
    },
  };
}

function report(name: string, options: Options = {}): SurfaceReport {
  const path = options.path ?? `packages/${name.replace(/^@\w+\//, "")}`;
  const owner = options.owner ?? name;
  const seeds = options.seeds ?? [];
  const history =
    options.window === undefined
      ? {
          analyzedAt: "2027-01-01T00:00:00.000Z",
          commitsAnalyzed: 10,
          historyComplete: true,
          since: "2026-01-01T00:00:00.000Z",
          windowDays: 365,
        }
      : { ...options.window, commitsAnalyzed: 10, historyComplete: true };
  const schemaVersion = options.schemaVersion ?? 33;
  const policyVersion =
    options.policyVersion ?? (schemaVersion === 32 ? undefined : 23);
  const value = {
    schemaVersion,
    ...(policyVersion !== undefined && { policyVersion }),
    architecturalProfile: {
      target: {
        complexity: {},
        gravity: {
          cycleMember: false,
          dependencyReach: 0,
          dependentReach: 0,
          downstreamDepth: 0,
          fanIn: (options.incoming ?? []).length,
          fanOut: (options.outgoing ?? []).length,
          transitiveDependencies: 0,
          transitiveDependents: 0,
          upstreamDepth: 0,
        },
        intent: { anchored: false, designedExports: true },
        node: { id: name, kind: "package" },
        signals: [],
        surface: {},
      },
    },
    boundaryInteractions: {
      incoming: (options.incoming ?? []).map((edge) =>
        interaction(edge.package, name, edge, true)
      ),
      outgoing: (options.outgoing ?? []).map((edge) =>
        interaction(name, edge.package, edge, false)
      ),
      summary: {},
      target: name,
    },
    changeCoupling: {
      available: true,
      filePairs: (options.couplings ?? []).map((pair) => ({
        ...pair,
        coChangeCommits: 3,
        context: "source-source",
        jaccard: 0.5,
        scope:
          pair.leftPackage === pair.rightPackage
            ? "same-package"
            : "cross-package",
        staticPath: "none",
      })),
      files: [],
      history: {},
      packagePairs: [],
      summary: {},
      target: name,
    },
    changeRadius: {
      available: true,
      commits: [],
      history: {},
      summary: {
        boundaries: { p50: 0 },
        boundaryCrossingRate: 0,
        commits: 4,
        crossPackageRate: 0.25,
        files: { p50: 2 },
        packages: { p50: 1 },
      },
      target: name,
    },
    churn: {
      available: true,
      distributions: {},
      files: (options.churn ?? []).map((file) => ({
        additions: file.commits * 10,
        authors: 1,
        commits: file.commits,
        deletions: 0,
        file: file.file,
        kind: "source",
        linesChanged: file.commits * 10,
        rank: { commitPercentile: 0, lineChurnPercentile: 0 },
      })),
      history,
      repository: {},
      summary: {},
      target: {},
    },
    conceptBehavioralLocality: {
      concepts: seeds.map((seed) => ({
        anchored: false,
        behavior: { byPackage: [] },
        concentration: {
          primaryModuleShare: 1,
          primaryPackage: name,
          primaryPackageShare: 1,
        },
        concept: identity(seed.id, seed.name, name, seed.file, true),
        shape: { modifiers: [], primary: "localized" },
        span: {
          boundaryEdges: [],
          moduleCount: 1,
          packageBoundaryCount: 0,
          packageCount: 1,
          sourceModuleCount: 1,
          sourcePackageCount: 1,
        },
      })),
      summary: {},
      target: name,
    },
    conceptInventory: {
      distribution: {},
      families: seeds.map((seed) => ({
        distribution: {
          moduleCount: 1,
          modules: [seed.file],
          packageCount: 1,
          packagePublicRepresentations: 1,
          packages: [name],
          references: 0,
        },
        distributionAnalysis: {
          references: { primaryShare: null, total: 0 },
          representations: {
            packages: [{ package: name, representations: 1 }],
            total: 1,
          },
          shapes: ["local"],
        },
        evidence: [],
        relationships: {},
        representations: [],
        seed: {
          declaration: { file: seed.file, package: name },
          id: seed.id,
          kind: "interface",
          name: seed.name,
          surface: {
            externallyUsed: false,
            moduleExported: true,
            packagePublic: true,
          },
        },
      })),
      summary: {},
      target: name,
    },
    conceptOverlap: {
      candidates: (options.overlaps ?? []).map((pair) => ({
        crossPackage: pair.left.package !== pair.right.package,
        dimensions: ["name"],
        evidence: [],
        left: { kind: "interface", ...pair.left },
        right: { kind: "interface", ...pair.right },
        shapes: ["projection-like"],
        structure: {
          baseShared: [],
          compatibleShared: ["id"],
          jaccard: 0.5,
          leftOnly: pair.leftOnly ?? [],
          rightOnly: pair.rightOnly ?? [],
          shared: ["id"],
          sharedOverLeft: 1 / (1 + (pair.leftOnly ?? []).length),
          sharedOverRight: 1 / (1 + (pair.rightOnly ?? []).length),
        },
        ...(pair.assignability !== undefined && {
          assignability: pair.assignability,
        }),
        bidirectionalConversion: false,
        conversions: pair.conversions ?? [],
      })),
      generation: {},
      summary: {},
      target: name,
    },
    conceptOwnership: {
      concepts: seeds.map((seed) => ({
        alignment: "aligned",
        candidates: [
          {
            package: name,
            participation: {
              behaviors: 0,
              conversions: 0,
              implementations: 0,
              references: 0,
              representations: 1,
            },
          },
        ],
        center: { implementations: [], semantic: name },
        concept: identity(seed.id, seed.name, name, seed.file, true),
        tensions: [],
      })),
      summary: {},
      target: name,
    },
    dependencies: {
      averageSymbolDistribution: 0,
      consumerPackages: (options.incoming ?? []).length,
      dependencyPackages: (options.outgoing ?? []).length,
      incoming: (options.incoming ?? []).map((edge) => ({
        importSites: edge.importSites,
        moduleEdges: edge.edges.map(([fromFile, toFile]) => ({
          fromFile,
          toFile,
        })),
        package: edge.package,
        referenceShare: 1,
        references: edge.importSites * 2,
        surfaceShare: 1,
        symbols: [],
        symbolsUsed: edge.distinct ?? 1,
        usageNamespace: "value",
      })),
      outgoing: (options.outgoing ?? []).map((edge) => ({
        moduleEdges: edge.edges.length,
        modules: edge.edges.map(([fromFile, toFile]) => ({ fromFile, toFile })),
        package: edge.package,
      })),
      shapeSignals: [],
    },
    dependencyGravity: {
      incomingConcentration: [],
      modules: seeds.map((seed) => ({
        cycle: { member: false, size: 0 },
        depth: { downstream: 0, upstream: 0 },
        direct: { fanIn: 0, fanOut: 0 },
        node: { id: seed.file, kind: "module" },
        reach: { dependencies: 0, dependents: 0 },
        role: {
          entrypoint: false,
          kind: "internal",
          ownDeclarations: 1,
          reExports: 0,
        },
        transitive: { dependencies: 0, dependents: 0 },
      })),
      outgoingConcentration: [],
      population: { modules: 10, packages: options.population ?? 2 },
      target: {},
    },
    evolutionaryPressure: { available: false, reason: "git-unavailable" },
    hotspots: {
      available: true,
      files: [],
      summary: {},
      target: name,
      windowDays: 365,
    },
    ineligibleOperations: [],
    localComplexity: { functions: [], summary: {} },
    operators: [],
    opportunities: [],
    plans: [],
    recenteringCandidates: {
      candidates: seeds
        .filter((seed) => seed.status !== undefined)
        .map((seed) => ({
          status: seed.status,
          subject: {
            concept: identity(seed.id, seed.name, name, seed.file, true),
          },
        })),
      impacts: {
        findings:
          (options.scenarios ?? []).length === 0
            ? []
            : [
                {
                  scenarios: (options.scenarios ?? []).map((scenario) => ({
                    certainty: { certain: 1, conditional: 0, unknown: 0 },
                    changes: [{ kind: "surface-relocation" }],
                    findingId: scenario.findingId,
                    impact: {
                      dependency: {
                        uncertain: [
                          { from: "@w/other", measured: false, to: "@w/far" },
                        ],
                      },
                    },
                    scenarioId: scenario.id,
                    status: "simulated",
                    summary: ["moved"],
                    uncertainties: [{ kind: "composition-root-remains" }],
                  })),
                },
              ],
        summary: {},
        target: name,
      },
      miscentered: {
        assessed: [],
        findings: (options.findings ?? []).map((finding) => ({
          anchored: false,
          concept: identity(finding.conceptId, "C", owner, "f.ts", true),
          declaredHome: { anchored: false, module: "f.ts", package: owner },
          evidenceConfidence: 0.6,
          id: finding.id,
          mismatch: 0.4,
          observedCenters: [
            { anchored: false, gravity: 0.7, shares: {}, target: "@w/other" },
          ],
          signal: "external-gravity",
        })),
        summary: {},
        target: name,
      },
      reviews: {
        reviews: (options.reviews ?? []).map((review) => ({
          baselineScenarioId: review.scenarioIds[0] ?? "",
          concept: identity(review.conceptId, "C", owner, "f.ts", true),
          disposition: "credible-alternative",
          dominated: [],
          findingId: review.findingId,
          invalid: [],
          scenarios: review.scenarioIds.map((scenarioId, index) => ({
            scenarioId,
            status: index === 0 ? "baseline" : "viable",
          })),
          unresolved: [
            {
              detail: "unmeasured edge",
              kind: "partial-simulation",
              scenarioIds: review.scenarioIds,
            },
          ],
          viable: review.scenarioIds,
        })),
        summary: {},
        target: name,
      },
      scenarios: {
        findings:
          (options.scenarios ?? []).length === 0
            ? []
            : [
                {
                  scenarios: (options.scenarios ?? []).map((scenario) => ({
                    confidence: "moderate",
                    constraints: [{ kind: "public-contract", package: owner }],
                    findingId: scenario.findingId,
                    id: scenario.id,
                    kind: "rehome-behavior",
                    proposed: { semanticCenter: "@w/other" },
                    status: "plausible",
                    subject: identity(
                      scenario.conceptId,
                      "C",
                      owner,
                      "f.ts",
                      true
                    ),
                  })),
                },
              ],
        summary: {},
        target: name,
      },
      summary: {},
      target: name,
    },
    structuralPressure: { boundaries: [], signals: [], target: name },
    summary: {
      declaredSurfaceRatio: 0,
      exportUtilization: 0,
      externallyUsedSymbols: 0,
      externalSurfaceRatio: 0,
      moduleExportedSymbols: seeds.length,
      moduleOnlyExports: 0,
      packagePublicSymbols: seeds.length,
      totalSymbols: seeds.length,
      unusedExternalExports: 0,
    },
    symbols: [],
    target: { boundaryType: "package", name, path },
  };
  // Test-only: the sections above are exactly what ingestion reads; the
  // remaining SurfaceReport detail is irrelevant to workspace facts.
  return value as unknown as SurfaceReport;
}

const A = "@w/a";
const B = "@w/b";
const aFile = "packages/a/src/a.ts";
const bFile = "packages/b/src/b.ts";
const edge: [string, string] = [aFile, bFile];

describe("boundaries and edges", () => {
  it("merges an outgoing and an incoming observation of one boundary", () => {
    const ws = ingestWorkspaceReports([
      report(A, { outgoing: [{ edges: [edge], importSites: 10, package: B }] }),
      report(B, { incoming: [{ edges: [edge], importSites: 10, package: A }] }),
    ]);
    expect(ws.boundaries.boundaries).toHaveLength(1);
    const [boundary] = ws.boundaries.boundaries;
    expect(boundary?.id).toBe(`${A}→${B}`);
    expect(boundary?.importSites).toBe(10);
    expect(boundary?.verified).toBe(true);
    expect(boundary?.provenance.observedBy).toEqual([A, B]);
    expect(boundary?.perspectives.source?.observedBy).toBe(A);
    expect(boundary?.perspectives.destination?.observedBy).toBe(B);
    expect(boundary?.symbols.references).toBe(20);
    expect(ws.graph.dependencyEdges).toHaveLength(1);
    expect(ws.graph.dependencyEdges[0]?.verified).toBe(true);
    expect(ws.graph.moduleEdges).toHaveLength(1);
    expect(ws.graph.moduleEdges[0]?.provenance.observedBy).toEqual([A, B]);
    expect(ws.ingestion.naive.moduleEdge).toBe(2);
    expect(ws.ingestion.canonical.moduleEdge).toBe(1);
    expect(ws.ingestion.conflicts).toEqual([]);
  });

  it("records a perspective difference as a target-scoped conflict, never a sum", () => {
    const ws = ingestWorkspaceReports([
      report(A, { outgoing: [{ edges: [edge], importSites: 10, package: B }] }),
      report(B, { incoming: [{ edges: [edge], importSites: 11, package: A }] }),
    ]);
    const [boundary] = ws.boundaries.boundaries;
    expect(boundary?.importSites).toBe(11);
    expect(boundary?.verified).toBe(true);
    expect(boundary?.perspectives.source?.importSites).toBe(10);
    expect(ws.ingestion.conflicts).toEqual([
      {
        entity: "boundary",
        entityId: `${A}→${B}`,
        field: "importSites",
        observations: [
          { sourcePackage: A, value: 10 },
          { sourcePackage: B, value: 11 },
        ],
        resolution: "target-scoped",
      },
    ]);
  });

  it("leaves a module-edge disagreement unresolved", () => {
    const ws = ingestWorkspaceReports([
      report(A, {
        outgoing: [
          {
            edges: [edge, [aFile, "packages/b/src/c.ts"]],
            importSites: 10,
            package: B,
          },
        ],
      }),
      report(B, { incoming: [{ edges: [edge], importSites: 10, package: A }] }),
    ]);
    expect(ws.boundaries.boundaries[0]?.verified).toBe(false);
    expect(ws.graph.dependencyEdges[0]?.verified).toBe(false);
    const unresolved = ws.ingestion.conflicts.filter(
      (c) => c.resolution === "unresolved"
    );
    expect(unresolved.map((c) => `${c.entity}.${c.field}`)).toEqual([
      "boundary.moduleEdges",
      "dependencyEdge.moduleEdges",
    ]);
  });

  it("keeps A→B and B→A as two edges", () => {
    const ws = ingestWorkspaceReports([
      report(A, {
        incoming: [{ edges: [[bFile, aFile]], importSites: 1, package: B }],
        outgoing: [{ edges: [edge], importSites: 1, package: B }],
      }),
    ]);
    expect(ws.graph.dependencyEdges.map((e) => e.id)).toEqual([
      `${A}→${B}`,
      `${B}→${A}`,
    ]);
    expect(ws.boundaries.boundaries).toHaveLength(2);
  });
});

describe("concepts", () => {
  const seed = { file: aFile, id: `${aFile}#Thing`, name: "Thing" };
  const partner = {
    file: bFile,
    id: `${bFile}#ThingRow`,
    inTarget: true,
    name: "ThingRow",
    package: B,
  };

  it("unifies a seed and a foreign overlap observation into one concept", () => {
    const ws = ingestWorkspaceReports([
      report(A, { seeds: [seed] }),
      report(B, {
        overlaps: [
          {
            left: { ...partner },
            right: { ...seed, inTarget: false, package: A },
          },
        ],
      }),
    ]);
    const thing = ws.concepts.concepts.find((c) => c.id === seed.id);
    expect(thing?.analysis).toBe("seed-report");
    expect(thing?.ownership?.alignment).toBe("aligned");
    expect(thing?.locality?.shape).toBe("localized");
    expect(thing?.observations).toEqual([
      { role: "seed", source: A },
      { role: "overlap-partner", source: B },
    ]);
    expect(thing?.provenance.observedBy).toEqual([A, B]);
    expect(thing?.overlaps).toEqual([`${seed.id}|${partner.id}`]);
    expect(ws.ingestion.naive.concept).toBe(2);
    expect(ws.ingestion.canonical.concept).toBe(1);
  });

  it("keeps two unrelated concepts with the same display name apart", () => {
    const ws = ingestWorkspaceReports([
      report(A, {
        seeds: [{ file: aFile, id: `${aFile}#Status`, name: "Status" }],
      }),
      report(B, {
        seeds: [{ file: bFile, id: `${bFile}#Status`, name: "Status" }],
      }),
    ]);
    expect(ws.concepts.concepts.map((c) => c.id)).toEqual([
      `${aFile}#Status`,
      `${bFile}#Status`,
    ]);
    expect(ws.concepts.byPackage).toEqual({
      [A]: [`${aFile}#Status`],
      [B]: [`${bFile}#Status`],
    });
  });

  it("leaves a partner-only concept without ownership or locality", () => {
    const ws = ingestWorkspaceReports([
      report(A, {
        overlaps: [
          {
            left: { ...seed, inTarget: true, package: A },
            right: { ...partner, inTarget: false },
          },
        ],
        seeds: [seed],
      }),
    ]);
    const row = ws.concepts.concepts.find((c) => c.id === partner.id);
    expect(row?.analysis).toBe("foreign-only");
    expect(row?.ownership).toBeUndefined();
    expect(row?.locality).toBeUndefined();
    expect(row?.observations).toEqual([{ role: "overlap-partner", source: A }]);
    expect(ws.packages.packages.find((p) => p.id === B)?.analyzed).toBe(false);
  });

  it("records one observation per source and role however many candidates name a partner", () => {
    const other = { file: aFile, id: `${aFile}#Other`, name: "Other" };
    const ws = ingestWorkspaceReports([
      report(A, {
        overlaps: [
          {
            left: { ...seed, inTarget: true, package: A },
            right: { ...partner, inTarget: false },
          },
          {
            left: { ...other, inTarget: true, package: A },
            right: { ...partner, inTarget: false },
          },
        ],
        seeds: [seed, other],
      }),
    ]);
    const row = ws.concepts.concepts.find((c) => c.id === partner.id);
    expect(row?.observations).toEqual([{ role: "overlap-partner", source: A }]);
    expect(row?.overlaps).toHaveLength(2);
  });

  it("canonicalizes overlap orientation and flips directional evidence", () => {
    const conversion = {
      file: bFile,
      from: seed.id,
      function: "toRow",
      to: partner.id,
    };
    const ws = ingestWorkspaceReports([
      report(A, {
        overlaps: [
          {
            assignability: "left-to-right",
            conversions: [conversion],
            left: { ...seed, inTarget: true, package: A },
            leftOnly: ["x"],
            right: { ...partner, inTarget: false },
            rightOnly: ["z", "y"],
          },
        ],
        seeds: [seed],
      }),
      report(B, {
        overlaps: [
          {
            assignability: "right-to-left",
            conversions: [conversion],
            left: partner,
            leftOnly: ["y", "z"],
            right: { ...seed, inTarget: false, package: A },
            rightOnly: ["x"],
          },
        ],
      }),
    ]);
    expect(ws.concepts.overlaps).toHaveLength(1);
    const [pair] = ws.concepts.overlaps;
    expect(pair?.left.id).toBe(seed.id);
    expect(pair?.structure?.leftOnly).toEqual(["x"]);
    expect(pair?.structure?.rightOnly).toEqual(["y", "z"]);
    expect(pair?.assignability).toBe("left-to-right");
    expect(pair?.conversions).toEqual([conversion]);
    expect(pair?.verified).toBe(true);
    expect(pair?.provenance.observedBy).toEqual([A, B]);
    expect(ws.ingestion.conflicts).toEqual([]);
  });
});

describe("evolution", () => {
  it("canonicalizes a reversed coupling pair with its conditionals and relation", () => {
    const ws = ingestWorkspaceReports([
      report(A, {
        couplings: [
          {
            left: aFile,
            leftCommits: 4,
            leftConditional: 0.75,
            leftPackage: A,
            right: bFile,
            rightCommits: 8,
            rightConditional: 0.375,
            rightPackage: B,
            staticRelation: "left-to-right",
          },
        ],
      }),
      report(B, {
        couplings: [
          {
            left: bFile,
            leftCommits: 8,
            leftConditional: 0.375,
            leftPackage: B,
            right: aFile,
            rightCommits: 4,
            rightConditional: 0.75,
            rightPackage: A,
            staticRelation: "right-to-left",
          },
        ],
      }),
    ]);
    expect(ws.evolution.couplings).toHaveLength(1);
    const [pair] = ws.evolution.couplings;
    expect(pair).toMatchObject({
      left: aFile,
      leftCommits: 4,
      leftConditional: 0.75,
      leftPackage: A,
      right: bFile,
      rightCommits: 8,
      rightConditional: 0.375,
      rightPackage: B,
      staticRelation: "left-to-right",
      verified: true,
    });
    expect(ws.ingestion.conflicts).toEqual([]);
  });

  it("keeps churn from different history windows apart", () => {
    const shared = "packages/a/src/shared.ts";
    const ws = ingestWorkspaceReports([
      report(A, { churn: [{ commits: 5, file: shared }] }),
      report(B, {
        churn: [{ commits: 3, file: shared }],
        window: {
          analyzedAt: "2027-01-01T00:00:00.000Z",
          since: "2026-06-01T00:00:00.000Z",
          windowDays: 180,
        },
      }),
    ]);
    expect(ws.evolution.churn).toHaveLength(1);
    const [file] = ws.evolution.churn;
    expect(file?.commits).toBe(5);
    expect(file?.package).toBe(A);
    expect(file?.observations.map((o) => [o.source, o.commits])).toEqual([
      [A, 5],
      [B, 3],
    ]);
    expect(ws.ingestion.conflicts.map((c) => [c.entity, c.resolution])).toEqual(
      [["churn", "target-scoped"]]
    );
  });
});

describe("re-centering artifacts", () => {
  const findingId = `${aFile}#Thing`;
  const scenarioId = `${findingId}::rehome-behavior::@w/other`;
  const artifacts = {
    findings: [{ conceptId: findingId, id: findingId }],
    reviews: [{ conceptId: findingId, findingId, scenarioIds: [scenarioId] }],
    scenarios: [{ conceptId: findingId, findingId, id: scenarioId }],
  };

  it("deduplicates the same finding observed by two reports and keeps associations", () => {
    const ws = ingestWorkspaceReports([
      report(A, artifacts),
      report("@w/a-dir", { owner: A, path: "packages/a/src", ...artifacts }),
    ]);
    const recentering = ws.architecture.recentering;
    expect(recentering.findings).toHaveLength(1);
    expect(recentering.findings[0]?.provenance.observedBy).toEqual([
      A,
      "@w/a-dir",
    ]);
    expect(recentering.scenarios).toHaveLength(1);
    expect(recentering.scenarios[0]?.resolved).toBe(true);
    expect(recentering.scenarios[0]?.constraints).toEqual(["public-contract"]);
    expect(recentering.impacts).toHaveLength(1);
    expect(recentering.impacts[0]?.resolved).toBe(true);
    expect(recentering.impacts[0]).toMatchObject({
      uncertainties: ["composition-root-remains"],
      unmeasuredEdges: ["@w/other→@w/far"],
    });
    expect(recentering.reviews).toHaveLength(1);
    expect(recentering.reviews[0]?.resolved).toBe(true);
    expect(recentering.reviews[0]?.unresolved).toEqual([
      { kind: "partial-simulation", scenarioIds: [scenarioId] },
    ]);
    expect(ws.ingestion.conflicts).toEqual([]);
  });

  it("retains an orphan scenario with a broken-reference diagnostic", () => {
    const ws = ingestWorkspaceReports([
      report(A, { reviews: artifacts.reviews, scenarios: artifacts.scenarios }),
    ]);
    expect(ws.architecture.recentering.scenarios[0]?.resolved).toBe(false);
    expect(ws.architecture.recentering.reviews[0]?.resolved).toBe(false);
    expect(
      ws.ingestion.diagnostics.filter((d) => d.kind === "broken-reference")
    ).toHaveLength(2);
  });
});

describe("sources", () => {
  it("ignores an identical duplicate report", () => {
    const a = report(A, {
      population: 1,
      seeds: [{ file: aFile, id: `${aFile}#Thing`, name: "Thing" }],
    });
    const ws = ingestWorkspaceReports([a, structuredClone(a)]);
    expect(ws.ingestion).toMatchObject({
      duplicates: 1,
      reportsAccepted: 1,
      reportsReceived: 2,
      reportsRejected: 0,
    });
    expect(ws.concepts.concepts).toHaveLength(1);
    expect(ws.ingestion.diagnostics).toEqual([
      {
        detail: "identical report ignored",
        kind: "duplicate-source",
        source: A,
      },
    ]);
  });

  it("rejects an ambiguous target with two differing reports", () => {
    const ws = ingestWorkspaceReports([
      report(A, {
        seeds: [{ file: aFile, id: `${aFile}#Thing`, name: "Thing" }],
      }),
      report(A),
      report(B),
    ]);
    expect(ws.ingestion.reportsAccepted).toBe(1);
    expect(ws.ingestion.reportsRejected).toBe(2);
    expect(ws.sources.map((s) => s.package)).toEqual([B]);
    expect(ws.ingestion.diagnostics.map((d) => d.kind)).toContain(
      "ambiguous-target"
    );
  });

  it("accepts mixed policy versions with a diagnostic", () => {
    const ws = ingestWorkspaceReports([
      report(A, { policyVersion: 22 }),
      report(B, { policyVersion: 23 }),
    ]);
    expect(ws.ingestion.reportsAccepted).toBe(2);
    expect(ws.sources.map((s) => s.policyVersion)).toEqual([22, 23]);
    expect(ws.ingestion.diagnostics.map((d) => d.kind)).toEqual([
      "mixed-policy",
    ]);
  });

  it("accepts schema 32 without a policy version and flags it", () => {
    const ws = ingestWorkspaceReports([
      report(A, { population: 1, schemaVersion: 32 }),
    ]);
    expect(ws.ingestion.reportsAccepted).toBe(1);
    expect(ws.sources[0]?.policyVersion).toBeUndefined();
    expect(ws.ingestion.diagnostics.map((d) => d.kind)).toEqual([
      "unknown-policy",
    ]);
  });

  it("rejects an unsupported schema and an invalid shape", () => {
    const ws = ingestWorkspaceReports([
      report(A, { schemaVersion: 31 }),
      { hello: "world" },
      "not a report",
      { report: report(B, { policyVersion: 23, population: 1 }), seconds: 1 },
    ]);
    expect(ws.ingestion.reportsAccepted).toBe(1);
    expect(ws.ingestion.reportsRejected).toBe(3);
    expect(ws.ingestion.diagnostics.map((d) => d.kind)).toEqual([
      "invalid-shape",
      "invalid-shape",
      "unsupported-schema",
    ]);
  });

  it("represents partial coverage honestly", () => {
    const ws = ingestWorkspaceReports([
      report(A, {
        outgoing: [{ edges: [edge], importSites: 1, package: "@w/c" }],
        population: 5,
      }),
      report(B, { population: 5 }),
    ]);
    expect(ws.ingestion.coverage).toEqual({
      complete: false,
      missingPackages: ["@w/c"],
      packagesAnalyzed: 2,
      packagesKnown: 3,
      population: 5,
    });
    expect(ws.ingestion.diagnostics.map((d) => d.kind)).toEqual([
      "partial-coverage",
    ]);
  });

  it("is independent of input order and survives a JSON round trip", () => {
    const seed = { file: aFile, id: `${aFile}#Thing`, name: "Thing" };
    const partner = {
      file: bFile,
      id: `${bFile}#ThingRow`,
      inTarget: true,
      name: "ThingRow",
      package: B,
    };
    const reports = [
      report(A, {
        churn: [{ commits: 2, file: aFile }],
        outgoing: [{ edges: [edge], importSites: 10, package: B }],
        policyVersion: 23,
        seeds: [seed],
      }),
      report(B, {
        incoming: [{ edges: [edge], importSites: 11, package: A }],
        overlaps: [
          { left: partner, right: { ...seed, inTarget: false, package: A } },
        ],
        policyVersion: 23,
      }),
      report("@w/c", { policyVersion: 23 }),
    ];
    const forward = ingestWorkspaceReports(reports);
    const shuffled = ingestWorkspaceReports([
      reports[2],
      reports[0],
      reports[1],
    ]);
    expect(JSON.stringify(shuffled)).toBe(JSON.stringify(forward));
    expect(JSON.parse(JSON.stringify(forward))).toEqual(forward);
    expect(renderWorkspaceReport(forward)).toContain("WORKSPACE");
  });
});
