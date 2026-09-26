import type { AnalysisConfig } from "./config";
import { ANALYSIS_CONFIG } from "./config";
import { PAIR } from "./history-commits";
import type {
  ArchitecturalTension,
  ChangeCouplingPair,
  DependencyGravity,
  EvolutionaryEvidence,
  EvolutionaryPressureReport,
  EvolutionaryPressureSignal,
  FileHotspot,
  HotStructuralHub,
  PressureEvidence,
  StaticPressureSupport,
  StructuralPressureSignal,
  SurfaceReport,
} from "./types";

// Static × evolutionary pressure: does history reinforce, contradict, or
// leave unsupported what V5.3 already decided? Pure composition over the
// report's own sections — static paths come from V6.2, roles from V5.0.
// Never re-evaluates a V5 gate, never scores, never recommends.

export type EvolutionaryPressureSource = Pick<
  SurfaceReport,
  | "target"
  | "dependencies"
  | "dependencyGravity"
  | "localComplexity"
  | "architecturalProfile"
  | "boundaryInteractions"
  | "structuralPressure"
  | "churn"
  | "hotspots"
  | "changeCoupling"
  | "changeRadius"
>;

type Policy = AnalysisConfig["evolutionaryPressure"];

function evidence(
  dimension: EvolutionaryEvidence["dimension"],
  metric: string,
  value: EvolutionaryEvidence["value"],
  subject?: string
): EvolutionaryEvidence {
  return {
    dimension,
    metric,
    value,
    ...(subject !== undefined && { subject }),
  };
}

function partnerOf(pair: ChangeCouplingPair, target: string): string {
  return pair.left === target ? pair.right : pair.left;
}

function pairLabel(pair: ChangeCouplingPair): string {
  return `${pair.left} ↔ ${pair.right}`;
}

function isInternal(module: DependencyGravity): boolean {
  return module.role?.kind !== "aggregator";
}

type Available<T> = Extract<T, { available: true }>;

interface Context {
  churn: Available<SurfaceReport["churn"]>;
  coupling: Available<SurfaceReport["changeCoupling"]>;
  hotspots: Available<SurfaceReport["hotspots"]>;
  hubs: HotStructuralHub[];
  policy: Policy;
  radius: Available<SurfaceReport["changeRadius"]>;
  /** Package pairs at or above the recurring-relationship bar, strongest first. */
  recurringPackagePairs: ChangeCouplingPair[];
  source: EvolutionaryPressureSource;
  target: string;
}

function hotStructuralHubs(
  ctx: Omit<Context, "hubs" | "recurringPackagePairs">
): HotStructuralHub[] {
  const gate = ctx.policy.hotStructuralHub;
  const modules = new Map(
    ctx.source.dependencyGravity.modules.map((m) => [m.node.id, m])
  );
  const functions = new Map<string, number>();
  for (const fn of ctx.source.localComplexity.functions) {
    functions.set(fn.file, (functions.get(fn.file) ?? 0) + 1);
  }
  const hubs: HotStructuralHub[] = [];
  for (const file of ctx.churn.files) {
    const module = modules.get(file.file);
    if (module === undefined) {
      continue;
    }
    if (!gate.eligibleKinds.includes(file.kind)) {
      continue;
    }
    if (file.rank.commitPercentile < gate.minCommitPercentile) {
      continue;
    }
    if (module.direct.fanIn < gate.minModuleFanIn) {
      continue;
    }
    hubs.push({
      file: file.file,
      ...(module.role !== undefined && { role: module.role.kind }),
      commitPercentile: file.rank.commitPercentile,
      commits: file.commits,
      fanIn: module.direct.fanIn,
      fanOut: module.direct.fanOut,
      functions: functions.get(file.file) ?? 0,
    });
  }
  return hubs.sort(
    (a, b) => b.commits - a.commits || a.file.localeCompare(b.file)
  );
}

function radiusEvidence(ctx: Context): EvolutionaryEvidence[] {
  const { summary } = ctx.radius;
  return [
    evidence("radius", "crossPackageRate", summary.crossPackageRate),
    evidence("radius", "boundaryCrossingRate", summary.boundaryCrossingRate),
    evidence("radius", "packagesP50", summary.packages.p50),
    evidence("radius", "packagesP90", summary.packages.p90),
  ];
}

function packagePairEvidence(pair: ChangeCouplingPair, target: string) {
  const partner = partnerOf(pair, target);
  return [
    evidence(
      "coupling",
      "packageCoChangeCommits",
      pair.coChangeCommits,
      partner
    ),
    evidence(
      "coupling",
      "targetConditional",
      pair.left === target ? pair.leftConditional : pair.rightConditional,
      partner
    ),
    evidence("coupling", "staticRelation", pair.staticRelation, partner),
  ];
}

function combinationWith(ctx: Context, partner: string) {
  return ctx.radius.summary.packageCombinations.find(
    (combination) =>
      combination.packages.length === 2 &&
      combination.packages.includes(ctx.target) &&
      combination.packages.includes(partner)
  );
}

interface Verdict {
  evolutionary: EvolutionaryEvidence[];
  reinforced: boolean;
}

/**
 * Integration reinforced when commits usually cross a static edge, or when
 * one edge-connected package pair recurs — the rate alone sits in a dense
 * part of the repository distribution.
 */
function integration(ctx: Context): Verdict {
  const gates = ctx.policy.integration;
  const { summary } = ctx.radius;
  const connected = ctx.recurringPackagePairs.filter(
    (pair) => pair.staticPath === "direct"
  );
  return {
    evolutionary: [
      ...radiusEvidence(ctx),
      evidence("coupling", "recurringConnectedPairs", connected.length),
      ...connected.flatMap((pair) => packagePairEvidence(pair, ctx.target)),
    ],
    reinforced:
      summary.boundaryCrossingRate >= gates.minBoundaryCrossingRate ||
      connected.length > 0,
  };
}

function surface(ctx: Context): Verdict {
  const primary = ctx.source.dependencies.primaryConsumer?.package;
  if (primary === undefined) {
    return { evolutionary: [], reinforced: false };
  }
  const min = ctx.policy.coupling.minPackageCommits;
  const pair = ctx.coupling.packagePairs.find(
    (candidate) => partnerOf(candidate, ctx.target) === primary
  );
  const combination = combinationWith(ctx, primary);
  const withPrimary = ctx.radius.commits.filter((commit) =>
    commit.packageSet.includes(primary)
  ).length;
  const evolutionary: EvolutionaryEvidence[] = [
    evidence("radius", "commitsWithPrimaryConsumer", withPrimary, primary),
  ];
  if (pair !== undefined) {
    evolutionary.push(...packagePairEvidence(pair, ctx.target));
  }
  if (combination !== undefined) {
    evolutionary.push(
      evidence("radius", "combinationCommits", combination.commits, primary)
    );
  }
  return {
    evolutionary,
    reinforced:
      (pair !== undefined && pair.coChangeCommits >= min) ||
      (combination !== undefined && combination.commits >= min),
  };
}

function centralization(ctx: Context): Verdict {
  const gates = ctx.policy.centralization;
  const churnByFile = new Map(ctx.churn.files.map((f) => [f.file, f]));
  const hotspotFiles = new Set(ctx.hotspots.files.map((h) => h.file));
  // Same basis as V5.3's destination concentration: import sites by
  // declaring module, so seams are where traffic lands, not the barrels.
  const sites = new Map<string, number>();
  for (const boundary of ctx.source.boundaryInteractions.incoming) {
    for (const contribution of boundary.destinationModules) {
      sites.set(
        contribution.module,
        (sites.get(contribution.module) ?? 0) + contribution.importSites
      );
    }
  }
  const seams = [...sites]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, gates.topSeams);
  const evolutionary: EvolutionaryEvidence[] = [];
  let reinforced = false;
  for (const [seam, importSites] of seams) {
    const file = churnByFile.get(seam);
    const crossPairs = ctx.coupling.filePairs.filter(
      (pair) =>
        pair.scope === "cross-package" &&
        (pair.left === seam || pair.right === seam)
    );
    const hot =
      file !== undefined &&
      file.rank.commitPercentile >= gates.minCommitPercentile;
    const seamReinforced =
      hot || hotspotFiles.has(seam) || crossPairs.length > 0;
    reinforced ||= seamReinforced;
    evolutionary.push(
      evidence("radius", "incomingImportSites", importSites, seam),
      evidence("churn", "commits", file?.commits ?? 0, seam),
      evidence(
        "churn",
        "commitPercentile",
        file?.rank.commitPercentile ?? 0,
        seam
      ),
      evidence("hotspot", "hotspot", hotspotFiles.has(seam), seam),
      evidence("coupling", "crossPackagePairs", crossPairs.length, seam)
    );
    const strongest = crossPairs[0];
    if (strongest !== undefined) {
      evolutionary.push(
        evidence(
          "coupling",
          "strongestPartner",
          partnerOf(strongest, seam),
          seam
        ),
        evidence("coupling", "coChangeCommits", strongest.coChangeCommits, seam)
      );
    }
    evolutionary.push(
      evidence("coupling", "seamReinforced", seamReinforced, seam)
    );
  }
  return { evolutionary, reinforced };
}

/**
 * Internal structure reinforced by history landing on internal centers:
 * a hotspot in a high-gravity module, a hot internal hub, or a same-package
 * pair touching one. Hot barrels are listed as hubs but do not reinforce —
 * a churning surface is not internal pressure.
 */
function internalStructure(ctx: Context): Verdict {
  const minFanIn = ctx.policy.hotStructuralHub.minModuleFanIn;
  const internalHubs = ctx.hubs.filter((hub) => hub.role !== "aggregator");
  const highGravity = new Set(
    ctx.source.dependencyGravity.modules
      .filter((m) => isInternal(m) && m.direct.fanIn >= minFanIn)
      .map((m) => m.node.id)
  );
  const centralHotspots = ctx.hotspots.files.filter(
    (h: FileHotspot) => (h.architecture?.moduleGravity?.fanIn ?? 0) >= minFanIn
  );
  const hubPairs = ctx.coupling.filePairs.filter(
    (pair) =>
      pair.scope === "same-package" &&
      pair.context === "source-source" &&
      (highGravity.has(pair.left) || highGravity.has(pair.right))
  );
  const evolutionary: EvolutionaryEvidence[] = [
    evidence("hotspot", "hotspots", ctx.hotspots.summary.hotspots),
    evidence("hotspot", "highGravityHotspots", centralHotspots.length),
    ...centralHotspots.map((h) =>
      evidence(
        "hotspot",
        "moduleFanIn",
        h.architecture?.moduleGravity?.fanIn ?? 0,
        h.file
      )
    ),
    evidence("churn", "hotStructuralHubs", ctx.hubs.length),
    evidence("churn", "internalHotHubs", internalHubs.length),
    ...ctx.hubs.map((hub) =>
      evidence("churn", "commits", hub.commits, hub.file)
    ),
    evidence("coupling", "internalHighGravityPairs", hubPairs.length),
    ...hubPairs
      .slice(0, 3)
      .map((pair) =>
        evidence(
          "coupling",
          "coChangeCommits",
          pair.coChangeCommits,
          pairLabel(pair)
        )
      ),
  ];
  return {
    evolutionary,
    reinforced:
      centralHotspots.length > 0 ||
      internalHubs.length > 0 ||
      hubPairs.length > 0,
  };
}

const VERDICTS: Record<
  StructuralPressureSignal["kind"],
  { kind: EvolutionaryPressureSignal["kind"]; check: (ctx: Context) => Verdict }
> = {
  "centralization-pressure": {
    check: centralization,
    kind: "reinforced-centralization-pressure",
  },
  "integration-pressure": {
    check: integration,
    kind: "reinforced-integration-pressure",
  },
  "internal-structure-pressure": {
    check: internalStructure,
    kind: "reinforced-internal-structure-pressure",
  },
  "surface-pressure": { check: surface, kind: "reinforced-surface-pressure" },
};

function leafTension(ctx: Context): ArchitecturalTension | undefined {
  const leaf = ctx.source.architecturalProfile.target.signals.find(
    (signal) => signal.signal === "leaf-like"
  );
  if (leaf === undefined) {
    return undefined;
  }
  const min = ctx.policy.coupling.minPackageCommits;
  const pair = ctx.recurringPackagePairs[0];
  const combination = ctx.radius.summary.packageCombinations.find(
    (c) => c.packages.length === 2 && c.commits >= min
  );
  if (pair === undefined && combination === undefined) {
    return undefined;
  }
  const evolutionary: EvolutionaryEvidence[] = [
    evidence("radius", "crossPackageRate", ctx.radius.summary.crossPackageRate),
  ];
  if (pair !== undefined) {
    evolutionary.push(...packagePairEvidence(pair, ctx.target));
  }
  if (combination !== undefined) {
    evolutionary.push(
      evidence(
        "radius",
        "combinationCommits",
        combination.commits,
        combination.packages.join(" + ")
      )
    );
  }
  // Name whichever relationship history shows more often: a package pair
  // can pass V6.2's strength gates on a small partner while the dominant
  // combination with a large consumer fails them on conditionals.
  const pairCommits = pair?.coChangeCommits ?? 0;
  const combinationCommits = combination?.commits ?? 0;
  const partner =
    pair !== undefined && pairCommits >= combinationCommits
      ? partnerOf(pair, ctx.target)
      : (combination?.packages.find((p) => p !== ctx.target) ?? "");
  return {
    evidence: {
      evolutionary,
      static: leaf.evidence.map((item) => ({ dimension: "gravity", ...item })),
    },
    kind: "static-leaf-temporal-coupling",
    summary: `Static topology places ${ctx.target} at the edge of the graph; history repeatedly changes it together with ${partner}.`,
    support: { commits: Math.max(pairCommits, combinationCommits) },
  };
}

function lowEvolutionTension(ctx: Context): ArchitecturalTension | undefined {
  const { signals } = ctx.source.structuralPressure;
  if (signals.length === 0) {
    return undefined;
  }
  const { summary } = ctx.radius;
  const quiet =
    summary.crossPackageRate <= ctx.policy.lowEvolution.maxCrossPackageRate &&
    ctx.hotspots.summary.hotspots === 0 &&
    ctx.recurringPackagePairs.length === 0;
  if (!quiet) {
    return undefined;
  }
  const seen = new Set<string>();
  const statics: PressureEvidence[] = [];
  for (const signal of signals) {
    for (const item of signal.evidence) {
      const key = `${item.dimension}${PAIR}${item.metric}`;
      if (!seen.has(key)) {
        seen.add(key);
        statics.push(item);
      }
    }
  }
  return {
    evidence: {
      evolutionary: [
        evidence("churn", "commits", ctx.churn.summary.commits),
        evidence("radius", "crossPackageRate", summary.crossPackageRate),
        evidence("radius", "packagesP50", summary.packages.p50),
        evidence("hotspot", "hotspots", 0),
        evidence("coupling", "recurringPackagePairs", 0),
      ],
      static: statics,
    },
    kind: "static-pressure-low-evolution",
    summary: `${signals.map((s) => s.kind).join(", ")} present statically; history shows mostly local change, no hotspots, and no recurring package coupling.`,
    support: { commits: ctx.radius.history.commitsEligible },
  };
}

/**
 * Source files that change together with no static path at all. Test
 * companions, story fixtures, and config pairs are visible on the V6.2
 * pairs but are not tensions: only source ↔ source can be a parallel
 * implementation the graph fails to explain.
 */
function noPathTensions(ctx: Context): ArchitecturalTension[] {
  const min = ctx.policy.coupling.minFileCommits;
  return ctx.coupling.filePairs
    .filter(
      (pair) =>
        pair.staticPath === "none" &&
        pair.context === "source-source" &&
        pair.coChangeCommits >= min
    )
    .map((pair) => {
      const label = pairLabel(pair);
      return {
        evidence: {
          evolutionary: [
            evidence(
              "coupling",
              "coChangeCommits",
              pair.coChangeCommits,
              label
            ),
            evidence(
              "coupling",
              "leftConditional",
              pair.leftConditional,
              label
            ),
            evidence(
              "coupling",
              "rightConditional",
              pair.rightConditional,
              label
            ),
            evidence("coupling", "jaccard", pair.jaccard, label),
          ],
          static: [
            {
              dimension: "gravity" as const,
              metric: "staticRelation",
              value: pair.staticRelation,
            },
            {
              dimension: "gravity" as const,
              metric: "staticPath",
              value: pair.staticPath,
            },
          ],
        },
        kind: "temporal-coupling-without-static-path" as const,
        summary: `${label} change together without any static path between them.`,
        support: { commits: pair.coChangeCommits },
      };
    });
}

/**
 * Compose evolutionary pressure from the report's own sections. Reinforced
 * and static-only partition the V5.3 signals; tensions describe where the
 * two stories disagree. Below the support gate every signal is
 * insufficient-history and no conclusion is drawn, but hubs (evidence, not
 * conclusions) are still listed.
 */
export function analyzeEvolutionaryPressure(
  source: EvolutionaryPressureSource,
  config: AnalysisConfig = ANALYSIS_CONFIG
): EvolutionaryPressureReport {
  const { churn, hotspots, changeCoupling, changeRadius } = source;
  if (!churn.available) {
    return { available: false, reason: churn.reason };
  }
  if (!hotspots.available) {
    return { available: false, reason: hotspots.reason };
  }
  if (!changeCoupling.available) {
    return { available: false, reason: changeCoupling.reason };
  }
  if (!changeRadius.available) {
    return { available: false, reason: changeRadius.reason };
  }
  const policy = config.evolutionaryPressure;
  const target = source.target.name ?? source.target.path;
  const partial = {
    churn,
    coupling: changeCoupling,
    hotspots,
    policy,
    radius: changeRadius,
    source,
    target,
  };
  const ctx: Context = {
    ...partial,
    hubs: hotStructuralHubs(partial),
    recurringPackagePairs: changeCoupling.packagePairs.filter(
      (pair) => pair.coChangeCommits >= policy.coupling.minPackageCommits
    ),
  };

  const support = {
    eligibleRadiusCommits: changeRadius.history.commitsEligible,
    fileCouplingPairs: changeCoupling.summary.filePairs,
    hotspots: hotspots.summary.hotspots,
    packageCouplingPairs: changeCoupling.summary.packagePairs,
  };
  const adequate = support.eligibleRadiusCommits >= policy.support.minCommits;

  const reinforced: EvolutionaryPressureSignal[] = [];
  const staticOnly: StaticPressureSupport[] = [];
  for (const signal of source.structuralPressure.signals) {
    const { kind, check } = VERDICTS[signal.kind];
    const verdict = check(ctx);
    if (adequate && verdict.reinforced) {
      reinforced.push({
        evolutionaryEvidence: verdict.evolutionary,
        intent: signal.intent,
        kind,
        staticEvidence: signal.evidence,
        staticSignal: signal.kind,
        support: { commits: support.eligibleRadiusCommits },
      });
    } else {
      staticOnly.push({
        evolutionaryEvidence: verdict.evolutionary,
        staticSignal: signal.kind,
        status: adequate ? "static-only" : "insufficient-history",
      });
    }
  }

  const tensions: ArchitecturalTension[] = [];
  if (adequate) {
    const leaf = leafTension(ctx);
    if (leaf !== undefined) {
      tensions.push(leaf);
    }
    const low = lowEvolutionTension(ctx);
    if (low !== undefined) {
      tensions.push(low);
    }
    tensions.push(
      ...noPathTensions(ctx).sort(
        (a, b) =>
          b.support.commits - a.support.commits ||
          a.summary.localeCompare(b.summary)
      )
    );
  }

  const { summary } = changeRadius;
  const edgeLess =
    summary.crossPackageCommits - summary.boundaryCrossingCommits;
  const rate = (n: number) => (summary.commits === 0 ? 0 : n / summary.commits);
  return {
    available: true,
    historicalSupport: adequate ? "adequate" : "insufficient",
    hotStructuralHubs: ctx.hubs,
    reinforced,
    spread: {
      boundaryCrossingRate: summary.boundaryCrossingRate,
      crossPackageRate: summary.crossPackageRate,
      edgeLessSpreadCommits: edgeLess,
      edgeLessSpreadRate: rate(edgeLess),
    },
    staticOnly,
    support,
    target,
    tensions,
  };
}
