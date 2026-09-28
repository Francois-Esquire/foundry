import { join } from "node:path";

import { describe, expect, it } from "vitest";
import { analyzeSurface } from "../../src/lib/analyze";
import type { ProfileSource } from "../../src/lib/architectural-profile";
import { buildArchitecturalProfile } from "../../src/lib/architectural-profile";
import { ANALYSIS_CONFIG } from "../../src/lib/config";
import { renderPressure, renderReport } from "../../src/lib/report";
import type { StructuralPressureSource } from "../../src/lib/structural-pressure";
import { analyzeStructuralPressure } from "../../src/lib/structural-pressure";
import type {
  BoundaryInteraction,
  BoundaryModuleContribution,
  DependencyGravity,
  FunctionComplexity,
  MetricAggregate,
  StructuralPressureKind,
} from "../../src/lib/types";

function aggregate(p95: number, max: number): MetricAggregate {
  return { average: 0, distribution: { max, p50: 0, p90: 0, p95 }, total: 0 };
}

/** A function with 6 control-flow decisions: exactly the branch-heavy bar. */
function branchHeavyFunction(index: number): FunctionComplexity {
  return {
    exported: false,
    file: "packages/t/src/logic.ts",
    id: `packages/t/src/logic.ts#L${index + 1}C1#fn${index}`,
    kind: "function",
    line: index + 1,
    metrics: {
      async: { async: false, awaits: 0, generator: false, yields: 0 },
      callbacks: { maxDepth: 0, nestedFunctions: 0 },
      decisions: {
        cases: 0,
        catches: 0,
        controlFlow: 6,
        defaults: 0,
        elseIfs: 0,
        expression: 0,
        ifs: 6,
        logical: 0,
        loops: 0,
        switches: 0,
        ternaries: 0,
        total: 6,
      },
      exceptions: { catches: 0, finals: 0, tries: 0 },
      exits: { breaks: 0, continues: 0, returns: 1, throws: 0 },
      loops: { doWhile: 0, for: 0, forIn: 0, forOf: 0, total: 0, while: 0 },
      nesting: { max: 1 },
      parameters: { boolean: 0, defaulted: 0, optional: 0, rest: 0, total: 0 },
      statements: 6,
    },
    name: `fn${index}`,
    packagePublic: false,
  };
}

function moduleGravity(
  id: string,
  fanIn: number,
  fanOut: number,
  depth: number
): DependencyGravity {
  return {
    cycle: { member: false, size: 0 },
    depth: { downstream: depth, upstream: 0 },
    direct: { fanIn, fanOut },
    node: { id, kind: "module" },
    reach: { dependencies: 0, dependents: 0 },
    transitive: { dependencies: 0, dependents: 0 },
  };
}

interface BoundaryOptions {
  /** Declaring modules as [name, importSites]; share derives from the total. */
  destinations?: [string, number][];
  from?: string;
  importSites: number;
  references?: number | null;
  symbols: number;
  to?: string;
}

function boundaryOf(options: BoundaryOptions): BoundaryInteraction {
  const references = options.references === undefined ? 0 : options.references;
  const destinations: BoundaryModuleContribution[] = (
    options.destinations ?? [["packages/t/src/a.ts", options.importSites]]
  ).map(([module, importSites]) => ({
    importSites,
    module,
    moduleEdges: 0,
    references: null,
    share: options.importSites === 0 ? 0 : importSites / options.importSites,
    symbols: importSites,
  }));
  return {
    breadth: {
      destinationModules: destinations.length,
      sourceModules: 1,
    },
    concentration: {
      destinationModuleShare: destinations[0]?.share ?? 0,
      sourceModuleShare: 1,
    },
    destinationModules: destinations,
    from: options.from ?? "@x/consumer",
    importSites: options.importSites,
    moduleEdges: 1,
    sourceModules: [],
    surfaceCoverage: null,
    symbols: {
      distinct: options.symbols,
      packagePublic: null,
      references,
      referencesPerSymbol: null,
    },
    to: options.to ?? "@x/target",
    usage: {
      bothSymbols: 0,
      namespace: "value",
      typeOnlySymbols: 0,
      valueOnlySymbols: options.symbols,
    },
  };
}

interface SourceOptions {
  anchor?: { target: string; reason?: string };
  averageSymbolDistribution?: number;
  branchHeavyFunctions?: number;
  consumers?: number;
  dependencyReach?: number;
  dependentReach?: number;
  fanIn?: number;
  fanOut?: number;
  incoming?: BoundaryInteraction[];
  modules?: DependencyGravity[];
  outgoing?: BoundaryInteraction[];
  packageDepth?: number;
  packagePublic?: number;
  primaryShare?: number;
  used?: number;
}

function sourceOf(options: SourceOptions = {}): StructuralPressureSource {
  const packagePublic = options.packagePublic ?? 0;
  const used = options.used ?? 0;
  const incoming = options.incoming ?? [];
  const outgoing = options.outgoing ?? [];
  const totals = (boundaries: BoundaryInteraction[], measured: boolean) => ({
    importSites: boundaries.reduce((sum, b) => sum + b.importSites, 0),
    moduleEdges: boundaries.length,
    packages: boundaries.length,
    references: measured
      ? boundaries.reduce((sum, b) => sum + (b.symbols.references ?? 0), 0)
      : null,
    symbols: boundaries.reduce((sum, b) => sum + b.symbols.distinct, 0),
  });
  const target: DependencyGravity = {
    cycle: { member: false, size: 0 },
    depth: { downstream: options.packageDepth ?? 0, upstream: 0 },
    direct: { fanIn: options.fanIn ?? 0, fanOut: options.fanOut ?? 0 },
    node: { id: "@x/target", kind: "package" },
    reach: {
      dependencies: options.dependencyReach ?? 0,
      dependents: options.dependentReach ?? 0,
    },
    transitive: {
      dependencies: options.fanOut ?? 0,
      dependents: options.fanIn ?? 0,
    },
  };
  const profileSource: ProfileSource = {
    dependencies: {
      consumerPackages: options.consumers ?? 0,
      dependencyPackages: options.fanOut ?? 0,
      incoming: [],
      outgoing: [],
      ...(options.primaryShare !== undefined && {
        primaryConsumer: {
          package: "@x/primary",
          referenceShare: options.primaryShare,
          surfaceShare: 0,
        },
      }),
      averageSymbolDistribution: options.averageSymbolDistribution ?? 0,
      shapeSignals: [],
    },
    dependencyGravity: {
      incomingConcentration: [],
      internalEdges: [],
      modules: options.modules ?? [],
      outgoingConcentration: [],
      population: { modules: 10, packages: 10 },
      target,
    },
    localComplexity: {
      functions: Array.from(
        { length: options.branchHeavyFunctions ?? 0 },
        (_, i) => branchHeavyFunction(i)
      ),
      summary: {
        controlFlowDecisions: aggregate(0, 0),
        decisions: aggregate(0, 0),
        functionsAnalyzed: options.branchHeavyFunctions ?? 0,
        nesting: aggregate(0, 0),
        parameters: aggregate(0, 0),
        statements: aggregate(0, 0),
      },
    },
    opportunities: [],
    plans: [],
    summary: {
      declaredSurfaceRatio: 0,
      exportUtilization: packagePublic === 0 ? 0 : used / packagePublic,
      externallyUsedSymbols: used,
      externalSurfaceRatio: 0,
      moduleExportedSymbols: packagePublic,
      moduleOnlyExports: 0,
      packagePublicSymbols: packagePublic,
      totalSymbols: packagePublic,
      unusedExternalExports: packagePublic - used,
    },
    ...(options.anchor && { anchor: options.anchor }),
  };
  return {
    architecturalProfile: buildArchitecturalProfile(profileSource),
    boundaryInteractions: {
      incoming,
      outgoing,
      summary: {
        incoming: totals(incoming, true),
        outgoing: totals(outgoing, false),
        throughPaths: 0,
      },
      target: "@x/target",
    },
    dependencyGravity: profileSource.dependencyGravity,
    localComplexity: profileSource.localComplexity,
  };
}

function kinds(
  source: StructuralPressureSource,
  config = ANALYSIS_CONFIG
): StructuralPressureKind[] {
  return analyzeStructuralPressure(source, config).signals.map((s) => s.kind);
}

const surfaceShape = { packagePublic: 100, used: 10 };

describe("surface pressure", () => {
  it("fires on a large, underused, narrowly consumed surface", () => {
    const report = analyzeStructuralPressure(
      sourceOf({ ...surfaceShape, consumers: 1, primaryShare: 1 })
    );
    const [signal] = report.signals;
    expect(signal?.kind).toBe("surface-pressure");
    expect(signal?.id).toBe("surface-pressure:@x/target");
    expect(signal?.dimensions).toEqual(["surface", "consumption"]);
    expect(signal?.evidence).toEqual([
      { dimension: "surface", metric: "packagePublicSymbols", value: 100 },
      { dimension: "surface", metric: "externallyUsedSymbols", value: 10 },
      { dimension: "surface", metric: "exportUtilization", value: 0.1 },
      { dimension: "consumption", metric: "consumerPackages", value: 1 },
      { dimension: "consumption", metric: "primaryConsumerShare", value: 1 },
      {
        dimension: "consumption",
        metric: "averageSymbolDistribution",
        value: 0,
      },
    ]);
  });

  it("does not fire from the surface shape alone", () => {
    expect(
      kinds(
        sourceOf({
          ...surfaceShape,
          averageSymbolDistribution: 2.5,
          consumers: 5,
          primaryShare: 0.3,
        })
      )
    ).toEqual([]);
  });
});

describe("integration pressure", () => {
  const outgoing = [
    boundaryOf({
      from: "@x/target",
      importSites: 40,
      references: null,
      symbols: 20,
      to: "@x/a",
    }),
    boundaryOf({
      from: "@x/target",
      importSites: 30,
      references: null,
      symbols: 10,
      to: "@x/b",
    }),
  ];

  it("fires when gravity and outgoing traffic converge", () => {
    const [signal] = analyzeStructuralPressure(
      sourceOf({ dependencyReach: 0.3, fanOut: 5, outgoing })
    ).signals;
    expect(signal?.kind).toBe("integration-pressure");
    expect(signal?.dimensions).toEqual(["gravity", "boundary"]);
    expect(signal?.evidence).toContainEqual({
      dimension: "boundary",
      metric: "outgoingImportSites",
      value: 70,
    });
  });

  it("does not fire on gravity without traffic", () => {
    expect(kinds(sourceOf({ dependencyReach: 0.3, fanOut: 5 }))).toEqual([]);
  });
});

describe("centralization pressure", () => {
  it("fires when incoming gravity and traffic land on one module", () => {
    const incoming = [
      boundaryOf({
        destinations: [
          ["packages/t/src/core.ts", 54],
          ["packages/t/src/other.ts", 6],
        ],
        from: "@x/a",
        importSites: 60,
        references: 150,
        symbols: 20,
      }),
      boundaryOf({
        destinations: [
          ["packages/t/src/core.ts", 36],
          ["packages/t/src/x.ts", 4],
        ],
        from: "@x/b",
        importSites: 40,
        references: 50,
        symbols: 10,
      }),
    ];
    const [signal] = analyzeStructuralPressure(
      sourceOf({ dependentReach: 0.4, fanIn: 5, incoming })
    ).signals;
    expect(signal?.kind).toBe("centralization-pressure");
    expect(signal?.dimensions).toEqual(["gravity", "boundary"]);
    expect(signal?.evidence).toContainEqual({
      dimension: "boundary",
      metric: "destinationModule",
      value: "packages/t/src/core.ts",
    });
    expect(signal?.evidence).toContainEqual({
      dimension: "boundary",
      metric: "destinationConcentration",
      value: 0.9,
    });
  });
});

describe("internal structure pressure", () => {
  const modules = [
    moduleGravity("packages/t/src/models/index.ts", 40, 10, 14),
    moduleGravity("packages/t/src/leaf.ts", 1, 0, 2),
  ];

  it("fires when depth, internal module gravity, and branch-heavy functions converge", () => {
    const [signal] = analyzeStructuralPressure(
      sourceOf({ branchHeavyFunctions: 3, modules, packageDepth: 2 })
    ).signals;
    expect(signal?.kind).toBe("internal-structure-pressure");
    expect(signal?.dimensions).toEqual(["gravity", "complexity"]);
    expect(signal?.evidence).toContainEqual({
      dimension: "gravity",
      metric: "depthDelta",
      value: 12,
    });
    expect(signal?.evidence).toContainEqual({
      dimension: "gravity",
      metric: "topInternalModule",
      value: "packages/t/src/models/index.ts",
    });
    expect(signal?.evidence).toContainEqual({
      dimension: "complexity",
      metric: "branchHeavyFunctions",
      value: 3,
    });
  });

  it("does not fire without enough branch-heavy functions", () => {
    expect(
      kinds(sourceOf({ branchHeavyFunctions: 2, modules, packageDepth: 2 }))
    ).toEqual([]);
  });

  it("ignores aggregator gravity when looking for an internal center", () => {
    const barrelOnly = [
      {
        ...moduleGravity("packages/t/src/index.ts", 60, 10, 14),
        role: {
          entrypoint: true,
          kind: "aggregator" as const,
          ownDeclarations: 0,
          reExports: 12,
        },
      },
      {
        ...moduleGravity("packages/t/src/leaf.ts", 4, 0, 2),
        role: {
          entrypoint: false,
          kind: "internal" as const,
          ownDeclarations: 3,
          reExports: 0,
        },
      },
      // Test infrastructure with high fan-in is not an internal center.
      moduleGravity("packages/t/src/tests/setup.ts", 80, 5, 14),
    ];
    expect(
      kinds(
        sourceOf({
          branchHeavyFunctions: 3,
          modules: barrelOnly,
          packageDepth: 2,
        })
      )
    ).toEqual([]);
  });
});

describe("boundary pressure", () => {
  it("classifies high-volume dispersed traffic as broad", () => {
    const { boundaries } = analyzeStructuralPressure(
      sourceOf({
        incoming: [
          boundaryOf({
            destinations: [
              ["packages/t/src/a.ts", 30],
              ["packages/t/src/b.ts", 170],
            ],
            importSites: 200,
            references: 400,
            symbols: 80,
          }),
        ],
      })
    );
    expect(boundaries).toHaveLength(1);
    expect(boundaries[0]?.shape).toBe("broad");
    expect(boundaries[0]?.evidence).toContainEqual({
      dimension: "boundary",
      metric: "destinationConcentration",
      value: 0.15,
    });
  });

  it("classifies moderate traffic into one module as concentrated", () => {
    const { boundaries } = analyzeStructuralPressure(
      sourceOf({
        incoming: [
          boundaryOf({
            destinations: [
              ["packages/t/src/registry.ts", 18],
              ["packages/t/src/identity.ts", 3],
            ],
            importSites: 21,
            references: 37,
            symbols: 18,
          }),
        ],
      })
    );
    expect(boundaries[0]?.shape).toBe("concentrated");
    expect(boundaries[0]?.evidence).toContainEqual({
      dimension: "boundary",
      metric: "topDestinationModule",
      value: "packages/t/src/registry.ts",
    });
  });

  it("qualifies outgoing boundaries by import sites when references are null", () => {
    const { boundaries } = analyzeStructuralPressure(
      sourceOf({
        outgoing: [
          boundaryOf({
            destinations: [["packages/dep/src/ref.ts", 95]],
            from: "@x/target",
            importSites: 95,
            references: null,
            symbols: 55,
            to: "@x/dep",
          }),
        ],
      })
    );
    expect(boundaries[0]?.shape).toBe("mixed");
    expect(boundaries[0]?.evidence.some((e) => e.metric === "references")).toBe(
      false
    );
  });

  it("leaves light boundaries unsignalled", () => {
    expect(
      analyzeStructuralPressure(
        sourceOf({
          incoming: [
            boundaryOf({
              destinations: [
                ["packages/t/src/a.ts", 14],
                ["packages/t/src/b.ts", 16],
              ],
              importSites: 30,
              symbols: 18,
            }),
          ],
        })
      ).boundaries
    ).toEqual([]);
  });
});

describe("composition", () => {
  it("keeps simultaneous package signals", () => {
    const names = kinds(
      sourceOf({
        ...surfaceShape,
        consumers: 1,
        dependencyReach: 0.2,
        fanOut: 6,
        outgoing: [
          boundaryOf({
            from: "@x/target",
            importSites: 60,
            references: null,
            symbols: 30,
            to: "@x/a",
          }),
        ],
        primaryShare: 1,
      })
    );
    expect(names).toEqual(["surface-pressure", "integration-pressure"]);
  });

  it("carries intent on anchored targets without suppressing the signal", () => {
    const [signal] = analyzeStructuralPressure(
      sourceOf({
        ...surfaceShape,
        anchor: { reason: "intentional boundary", target: "@x/target" },
        consumers: 1,
        primaryShare: 1,
      })
    ).signals;
    expect(signal?.kind).toBe("surface-pressure");
    expect(signal?.intent).toEqual({
      anchored: true,
      anchorReason: "intentional boundary",
    });
  });

  it("responds to injected config instead of hardcoded policy", () => {
    const source = sourceOf({ ...surfaceShape, consumers: 1, primaryShare: 1 });
    const tuned = structuredClone(ANALYSIS_CONFIG);
    tuned.structuralPressure.surface.minPackagePublicSymbols = 500;
    expect(kinds(source)).toContain("surface-pressure");
    expect(kinds(source, tuned)).toEqual([]);
  });
});

describe("rendering", () => {
  it("renders evidence grouped by dimension and intent", () => {
    const report = {
      structuralPressure: analyzeStructuralPressure(
        sourceOf({
          ...surfaceShape,
          anchor: { reason: "intentional boundary", target: "@x/target" },
          consumers: 1,
          incoming: [
            boundaryOf({
              destinations: [
                ["packages/t/src/registry.ts", 18],
                ["packages/t/src/b.ts", 3],
              ],
              importSites: 21,
              references: 37,
              symbols: 18,
            }),
          ],
          primaryShare: 1,
        })
      ),
      target: {
        boundaryType: "package",
        name: "@x/target",
        path: "packages/target",
      },
    };
    const rendered = renderPressure(report as never);
    expect(rendered).toContain("Structural pressure signals  1");
    expect(rendered).toContain("SURFACE PRESSURE");
    expect(rendered).toContain("  Surface\n");
    expect(rendered).toContain("  Consumption\n");
    expect(rendered).toContain("export utilization         10.0%");
    expect(rendered).toContain("anchored — intentional boundary");
    expect(rendered).toContain("@x/consumer → @x/target");
    expect(rendered).toContain("shape                      concentrated");
    expect(rendered).toContain("destination concentration  85.7%");
  });

  it("stays silent on a fixture without pressure and attaches to the report", async () => {
    const root = join(import.meta.dirname, "fixtures", "traffic");
    const hub = await analyzeSurface({ root, target: "@traffic/hub" });
    expect(hub.schemaVersion).toBe(35);
    expect(hub.structuralPressure).toEqual({
      boundaries: [],
      signals: [],
      target: "@traffic/hub",
    });
    expect(renderReport(hub)).not.toContain("STRUCTURAL PRESSURE");
    expect(renderPressure(hub)).toContain("Boundary pressure signals    0");
  });

  it("classifies module roles syntactically: the barrel aggregates, core declares", async () => {
    const root = join(import.meta.dirname, "fixtures", "traffic");
    const hub = await analyzeSurface({ root, target: "@traffic/hub" });
    const roles = Object.fromEntries(
      hub.dependencyGravity.modules.map((m) => [m.node.id, m.role])
    );
    expect(roles["packages/hub/src/index.ts"]).toEqual({
      entrypoint: true,
      kind: "aggregator",
      ownDeclarations: 0,
      reExports: 2,
    });
    expect(roles["packages/hub/src/core.ts"]).toMatchObject({
      entrypoint: false,
      kind: "internal",
      reExports: 0,
    });
  });
});
