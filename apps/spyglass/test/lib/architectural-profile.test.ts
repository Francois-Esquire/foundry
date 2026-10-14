import { join } from "node:path";

import { beforeAll, describe, expect, it } from "vitest";
import { analyzeSurface } from "../../src/lib/analyze";
import type { ProfileSource } from "../../src/lib/architectural-profile";
import { buildArchitecturalProfile } from "../../src/lib/architectural-profile";
import { ANALYSIS_CONFIG } from "../../src/lib/config";
import { renderProfile, renderReport } from "../../src/lib/report";
import type {
  ArchitecturalProfileSignal,
  DependencyGravity,
  MetricAggregate,
  SurfaceReport,
} from "../../src/lib/types";

const zeroAggregate: MetricAggregate = {
  average: 0,
  distribution: { max: 0, p50: 0, p90: 0, p95: 0 },
  total: 0,
};

interface SourceOptions {
  anchor?: { target: string; reason?: string };
  averageSymbolDistribution?: number;
  cautionReasons?: string[];
  consumers?: number;
  dependencyReach?: number;
  dependentReach?: number;
  downstreamDepth?: number;
  fanIn?: number;
  fanOut?: number;
  moduleDepths?: number[];
  packagePublic?: number;
  primaryShare?: number;
  used?: number;
}

function sourceOf(options: SourceOptions = {}): ProfileSource {
  const packagePublic = options.packagePublic ?? 0;
  const used = options.used ?? 0;
  const target: DependencyGravity = {
    cycle: { member: false, size: 0 },
    depth: { downstream: options.downstreamDepth ?? 0, upstream: 0 },
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
  const cautionReasons = options.cautionReasons ?? [];
  return {
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
      modules: (options.moduleDepths ?? []).map((depth, index) => ({
        cycle: { member: false, size: 0 },
        depth: { downstream: depth, upstream: 0 },
        direct: { fanIn: 0, fanOut: 0 },
        node: { id: `packages/target/src/m${index}.ts`, kind: "module" },
        reach: { dependencies: 0, dependents: 0 },
        transitive: { dependencies: 0, dependents: 0 },
      })),
      outgoingConcentration: [],
      population: { modules: 10, packages: 10 },
      target,
    },
    localComplexity: {
      functions: [],
      summary: {
        controlFlowDecisions: zeroAggregate,
        decisions: zeroAggregate,
        functionsAnalyzed: 0,
        nesting: zeroAggregate,
        parameters: zeroAggregate,
        statements: zeroAggregate,
      },
    },
    opportunities:
      cautionReasons.length === 0
        ? []
        : [
            {
              cautions: cautionReasons.map((reason) => ({
                detail: "",
                reason,
              })),
              estimatedReduction: [],
              evidence: [],
              evidenceConfidence: 0,
              id: "opportunity",
              operation: "preserve-shared-boundary",
              subject: { id: "@x/target", name: "@x/target", type: "package" },
              summary: "",
            },
          ],
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
}

function signalNames(
  source: ProfileSource,
  config = ANALYSIS_CONFIG
): ArchitecturalProfileSignal[] {
  return buildArchitecturalProfile(source, config).target.signals.map(
    (result) => result.signal
  );
}

describe("signal eligibility", () => {
  it("matches nothing on an empty source", () => {
    expect(signalNames(sourceOf())).toEqual([]);
  });

  it("names foundation-like with exact evidence", () => {
    const source = sourceOf({ dependentReach: 0.3, fanIn: 3, fanOut: 0 });
    const profile = buildArchitecturalProfile(source).target;
    const foundation = profile.signals.find(
      (result) => result.signal === "foundation-like"
    );
    expect(foundation?.evidence).toEqual([
      { metric: "fanIn", value: 3 },
      { metric: "fanOut", value: 0 },
      { metric: "dependentReach", value: 0.3 },
      { metric: "dependencyReach", value: 0 },
    ]);
  });

  it("names integration-like and keeps high fan-out out of leaf-like", () => {
    const names = signalNames(
      sourceOf({
        dependencyReach: 0.2,
        dependentReach: 0.02,
        fanIn: 1,
        fanOut: 6,
      })
    );
    expect(names).toContain("integration-like");
    expect(names).not.toContain("leaf-like");
    expect(names).not.toContain("foundation-like");
  });

  it("names shared-hub-like and broadly-consumed on distributed consumption", () => {
    const names = signalNames(
      sourceOf({
        averageSymbolDistribution: 2.2,
        consumers: 4,
        dependentReach: 0.4,
        fanIn: 4,
        fanOut: 0,
        primaryShare: 0.4,
      })
    );
    expect(names).toContain("shared-hub-like");
    expect(names).toContain("broadly-consumed");
    expect(names).toContain("foundation-like");
  });

  it("names leaf-like only within the fan-out band", () => {
    expect(signalNames(sourceOf({ fanIn: 1, fanOut: 2 }))).toEqual([
      "leaf-like",
    ]);
    expect(signalNames(sourceOf({ fanIn: 1, fanOut: 3 }))).not.toContain(
      "leaf-like"
    );
  });

  it("does not name depth as a profile: package depth never separates packages", () => {
    expect(
      signalNames(sourceOf({ downstreamDepth: 2, moduleDepths: [9, 3] }))
    ).not.toContain("internally-deep");
  });

  it("names surface-heavy only above the minimum surface size", () => {
    const heavy = buildArchitecturalProfile(
      sourceOf({ packagePublic: 100, used: 10 })
    ).target;
    const signal = heavy.signals.find(
      (result) => result.signal === "surface-heavy"
    );
    expect(signal?.evidence).toEqual([
      { metric: "packagePublicSymbols", value: 100 },
      { metric: "externallyUsedSymbols", value: 10 },
      { metric: "exportUtilization", value: 0.1 },
    ]);
    expect(signalNames(sourceOf({ packagePublic: 10, used: 1 }))).not.toContain(
      "surface-heavy"
    );
  });

  it("names narrowly-consumed on concentrated usage", () => {
    const narrow = buildArchitecturalProfile(
      sourceOf({ consumers: 1, primaryShare: 1 })
    ).target;
    expect(narrow.signals).toEqual([
      {
        evidence: [
          { metric: "consumerPackages", value: 1 },
          { metric: "primaryConsumerShare", value: 1 },
        ],
        signal: "narrowly-consumed",
      },
    ]);
  });

  it("keeps simultaneous signals without overwriting", () => {
    const names = signalNames(
      sourceOf({
        dependentReach: 0.3,
        fanIn: 3,
        fanOut: 0,
        packagePublic: 100,
        used: 10,
      })
    );
    expect(names).toContain("foundation-like");
    expect(names).toContain("surface-heavy");
  });

  it("responds to injected config instead of hardcoded policy", () => {
    const source = sourceOf({ dependentReach: 0.3, fanIn: 3, fanOut: 0 });
    const tuned = structuredClone(ANALYSIS_CONFIG);
    tuned.architecturalProfiles.foundationLike.minFanIn = 5;
    expect(signalNames(source)).toContain("foundation-like");
    expect(signalNames(source, tuned)).not.toContain("foundation-like");
  });
});

describe("profile composition", () => {
  it("restates gravity and surface facts without new formulas", () => {
    const profile = buildArchitecturalProfile(
      sourceOf({
        averageSymbolDistribution: 1.8,
        consumers: 3,
        dependentReach: 0.3,
        fanIn: 3,
        fanOut: 1,
        packagePublic: 40,
        primaryShare: 0.5,
        used: 25,
      })
    ).target;
    expect(profile.node).toEqual({ id: "@x/target", kind: "package" });
    expect(profile.gravity.fanIn).toBe(3);
    expect(profile.gravity.dependentReach).toBe(0.3);
    expect(profile.gravity.cycleMember).toBe(false);
    expect(profile.surface.packagePublicSymbols).toBe(40);
    expect(profile.surface.exportUtilization).toBe(0.625);
    expect(profile.surface.primaryConsumerShare).toBe(0.5);
    expect(profile.complexity.functionsAnalyzed).toBe(0);
  });

  it("derives intent only from data already known", () => {
    const { intent } = buildArchitecturalProfile(
      sourceOf({
        anchor: { reason: "intentional boundary", target: "@x/target" },
        cautionReasons: ["publishable"],
      })
    ).target;
    expect(intent).toEqual({
      anchored: true,
      anchorReason: "intentional boundary",
      publishable: true,
    });
    expect(intent.designedExports).toBeUndefined();
    const bare = buildArchitecturalProfile(sourceOf()).target.intent;
    expect(bare).toEqual({ anchored: false });
  });
});

describe("fixture integration", () => {
  const root = join(import.meta.dirname, "fixtures", "deps");
  let report: SurfaceReport;

  beforeAll(async () => {
    report = await analyzeSurface({ root, target: "@deps/shared" });
  });

  it("profiles a real fan-in hub as foundation-like", () => {
    const { target } = report.architecturalProfile;
    const names = target.signals.map((result) => result.signal);
    expect(names).toContain("foundation-like");
    expect(target.gravity.fanIn).toBe(4);
    expect(target.gravity.fanOut).toBe(0);
    expect(target.complexity.functionsAnalyzed).toBe(
      report.localComplexity.summary.functionsAnalyzed
    );
  });

  it("adds a compact section to the default report", () => {
    const rendered = renderReport(report);
    expect(rendered).toContain("ARCHITECTURAL PROFILE");
    expect(rendered).toContain("  foundation-like");
  });

  it("renders the focused profile view with evidence", () => {
    const rendered = renderProfile(report);
    expect(rendered).toContain("FOUNDATION-LIKE");
    expect(rendered).toContain("fan in");
    expect(rendered).toContain("dependent reach");
    expect(rendered).toContain("GRAVITY");
    expect(rendered).toContain("SURFACE");
    expect(rendered).toContain("LOCAL COMPLEXITY");
  });
});
