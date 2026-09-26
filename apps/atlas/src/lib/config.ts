import type { ChurnFileKind, ConceptSeedKind, CouplingContext } from "./types";

/**
 * Central analysis policy. Every tunable threshold, gate, and evidence weight
 * that interprets the measurements lives here; the measurements themselves
 * (consumer counts, shares, distributions) are fixed facts. Signals and
 * evidence confidence describe how strongly the observed graph matches a
 * pattern — never verdicts, never quality gates. These are internal
 * defaults; there is intentionally no user-facing config loader yet. Ratio
 * values range 0.0–1.0.
 */

/**
 * An intentional architectural boundary. Anchoring never suppresses analysis
 * or hides structural facts — it blocks operations that would remove the
 * anchored package boundary (fold-package). Operations that only narrow the
 * public surface (internalize-export) remain allowed.
 */
export interface AnchorDefinition {
  reason?: string;
  /** Workspace package name or root-relative package path. */
  target: string;
}

export interface AnalysisConfig {
  /** Declared architectural intent; matched by package name or path. */
  anchors: AnchorDefinition[];
  /**
   * Gates for descriptive architectural-profile signals. Shapes, not
   * judgments: a gate decides whether a measured pattern is named, never
   * whether it is good.
   */
  architecturalProfiles: {
    foundationLike: {
      minFanIn: number;
      maxFanOut: number;
    };
    integrationLike: {
      maxFanIn: number;
      minFanOut: number;
    };
    sharedHubLike: {
      minFanIn: number;
      minConsumers: number;
      minAverageSymbolDistribution: number;
    };
    leafLike: {
      maxFanIn: number;
      minFanOut: number;
      maxFanOut: number;
    };
    surfaceHeavy: {
      maxExportUtilization: number;
      minPackagePublicSymbols: number;
    };
    narrowlyConsumed: {
      minPrimaryConsumerShare: number;
    };
    broadlyConsumed: {
      minConsumers: number;
      maxPrimaryConsumerShare: number;
    };
  };
  /**
   * V7.4 locality shapes read source behavior only; test and story
   * behavior stay visible beside it. Gates are counts and distances,
   * never weights.
   */
  behavioralLocality: {
    support: {
      /** Below this many source behaviors no locality shape is read. */
      minSourceBehaviors: number;
      /** Below this many, `sparse-source-behavior` is noted. */
      sparseSourceBehaviors: number;
    };
    /** Broad reference presence with at most this much source behavior. */
    behaviorLight: {
      maxSourceBehaviors: number;
      minReferenceModules: number;
    };
    singlePackageDistributed: { minModules: number };
    /** Several packages, several modules, and traversal breadth (distance or a disconnected pair). */
    crossPackageDistributed: {
      minPackages: number;
      minModules: number;
      minTraversalDistance: number;
    };
    parallelImplementations: { minPackages: number };
    report: {
      topConcepts: number;
      topModules: number;
      topExternalCompanions: number;
    };
  };
  /** Presentation only — boundary interaction carries no thresholds. */
  boundaryInteractions: {
    report: {
      topBoundaries: number;
      topModules: number;
    };
  };
  /**
   * Change-coupling policy. A pair is reported when support meets the
   * minimum AND any strength gate holds (either conditional, or Jaccard).
   */
  changeCoupling: {
    gates: {
      minCoChangeCommits: number;
      minConditional: number;
      minJaccard: number;
    };
    report: {
      topPairs: number;
    };
  };
  changeRadius: {
    report: {
      topCommits: number;
      topCombinations: number;
    };
  };
  churn: {
    /** History window for counts and line churn; null = full history. */
    windowDays: number | null;
    report: {
      /** Files listed per ranking in the focused churn view. */
      topFiles: number;
    };
  };
  /** V7.1 distribution shapes. Descriptive gates only; never a judgment. */
  conceptDistribution: {
    referenceDistributed: {
      /** References must fall in at least this many packages. */
      minPackages: number;
      /** And no package may hold more than this share of them. */
      maxPrimaryReferenceShare: number;
    };
    representationConcentrated: {
      /** Named representations (seed included) needed before the shape applies. */
      minRepresentations: number;
      /** Share of them one package must hold, with references in ≥ 2 packages. */
      minPrimaryShare: number;
    };
    report: {
      topFamilies: number;
      topPackages: number;
      topModules: number;
    };
  };
  /**
   * V7.2 overlap candidates. Generators only propose pairs; the gate decides.
   * Name affinity alone never qualifies, history alone never qualifies.
   */
  conceptOverlap: {
    name: {
      /** Low-information tokens: ignored for pair generation and affinity. */
      genericTokens: string[];
      /** Non-generic token Jaccard at which name affinity counts as evidence. */
      minJaccard: number;
    };
    properties: {
      /** Names too common to generate pairs; still counted in overlap ratios. */
      commonNames: string[];
      /** Shared property names required for the structural gate. */
      minSharedProperties: number;
      /** Property-name Jaccard required for the structural gate. */
      minJaccard: number;
      /**
       * Properties every Error-derived declaration inherits. Recorded as
       * `baseShared` and excluded from gating when both sides derive from
       * Error; own properties on an error still count.
       */
      errorBaseNames: string[];
    };
    generation: {
      /** A name token or property held by more declarations than this generates no pairs. */
      maxIndexFanout: number;
    };
    conversion: {
      /** Generic wrappers looked through in converter signatures. */
      wrappers: string[];
    };
    shapes: {
      /** Property Jaccard (all shared compatible) that reads as near-equivalent. */
      nearEquivalentMinJaccard: number;
      /**
       * Shared own properties (base Error properties excluded) below which
       * neither near-equivalence nor subset-share projection is read; one-way
       * checker assignability still reads as projection-like.
       */
      minSharedProperties: number;
      /** Share of the smaller shape found in the larger that reads as projection-like. */
      projectionMinSubsetShare: number;
    };
    gates: {
      minEvidenceDimensions: number;
    };
    report: {
      topCandidates: number;
    };
  };
  /**
   * V7.3 concept centers. Role gates are separate and transparent; there
   * is no combined ownership score. Shares are of the family total for the
   * dimension; all counts include the seed package.
   */
  conceptOwnership: {
    /** OR-style participation: the seed package always qualifies. */
    candidates: {
      /** A consumer needs this share of references. */
      minReferenceShare: number;
      /** Or this many named representations. */
      minRepresentations: number;
      /** Or this many explicit behaviors. */
      minBehaviors: number;
    };
    /** Below both, the family is `insufficient-evidence` and no centers are inferred. */
    support: {
      minReferences: number;
      minBehaviors: number;
    };
    /**
     * `fileKinds` names the file kinds whose representations the center and
     * its tension read; the rest stay visible as context. Test helpers and
     * story-only representations then cannot move a center.
     */
    representationCenter: {
      minShare: number;
      minRepresentations: number;
      fileKinds: ChurnFileKind[];
    };
    usageCenter: { minShare: number; minReferences: number };
    /** Contract behavior only; implementation members belong to implementation centers. */
    behaviorCenter: {
      minShare: number;
      minBehaviors: number;
      fileKinds: ChurnFileKind[];
    };
    /** Only coupling pairs in `couplingContexts` count toward historical support. */
    evolutionCenter: {
      minHistoricalSupport: number;
      couplingContexts: CouplingContext[];
    };
    /** Seed-vs-* tensions need this much of the dimension away from the seed. */
    tensions: {
      minShare: number;
      minRepresentations: number;
      minBehaviors: number;
      /** Seed-vs-* tensions that must point at one package before the anchor is questioned. */
      anchorMinConvergingDimensions: number;
    };
    report: {
      topConcepts: number;
    };
  };
  concepts: {
    /** Declaration kinds that seed a concept family. Functions and constants never do. */
    seedKinds: ConceptSeedKind[];
    report: {
      /** Families listed per section in the focused concept view. */
      topFamilies: number;
      /** Representations listed per relationship in a single-family view. */
      topRepresentations: number;
      /** Evidence lines shown in a single-family view; JSON keeps every one. */
      evidenceShown: number;
    };
  };
  dependency: {
    concentration: {
      highShare: number;
      distributedMaxShare: number;
    };
    shape: {
      distributedMinConsumers: number;
      highFanIn: number;
      highFanOut: number;
    };
  };
  dependencyGravity: {
    report: {
      /** Modules listed per top-N section in the focused gravity view. */
      topModules: number;
    };
  };
  /**
   * Static × evolutionary policy. Consumes V5.3 and V6 outputs as decided;
   * never re-evaluates whether a pressure exists, only whether history
   * reinforces it.
   */
  evolutionaryPressure: {
    support: {
      /** Eligible radius commits below this → insufficient-history. */
      minCommits: number;
    };
    integration: {
      /** Reinforced at this boundary-crossing rate, or by a recurring edge-connected pair. */
      minBoundaryCrossingRate: number;
    };
    coupling: {
      /** Package pair support that reads as a recurring relationship. */
      minPackageCommits: number;
      /** File pair support for the no-static-path tension. */
      minFileCommits: number;
    };
    centralization: {
      /** Incoming-concentration modules examined as seams. */
      topSeams: number;
      minCommitPercentile: number;
    };
    hotStructuralHub: {
      /** Only these file kinds can be hubs; test and story gravity is not architecture. */
      eligibleKinds: ChurnFileKind[];
      minCommitPercentile: number;
      minModuleFanIn: number;
    };
    lowEvolution: {
      /** Cross-package rate at or below which spread reads as mostly local. */
      maxCrossPackageRate: number;
    };
    report: {
      /** Tensions shown in the focused view; JSON keeps every one. */
      topTensions: number;
      topHubs: number;
    };
  };
  /**
   * The one historical commit filter behind change coupling, change radius,
   * and evolutionary pressure. Churn itself never filters commits.
   */
  history: {
    /** File kinds a commit's files must have to count at all. */
    eligibleKinds: ChurnFileKind[];
    composition: {
      /** Config share at or above this → config-dominant. */
      configDominantMinShare: number;
      /** Config share at or below this → source-dominant; between → mixed. */
      sourceDominantMaxConfigShare: number;
    };
    oversized: {
      /** Code files (source, test, story) above this → oversized. */
      maxCodeFilesPerCommit: number;
      /** Config-dominant commits spanning this many packages → sweep. */
      configSweepMinPackages: number;
    };
  };
  /**
   * Hotspot policy. The commit gate is mandatory; the complexity gates are
   * OR-ed (any one suffices). Architecture never affects eligibility.
   */
  hotspots: {
    eligibleKinds: ChurnFileKind[];
    gates: {
      minCommitPercentile: number;
      complexity: {
        minMaxControlFlowDecisions: number;
        minMaxNesting: number;
        minTotalControlFlowDecisions: number;
        /** `complexity-dense` needs the total spread over this many functions. */
        minFunctionsForDense: number;
      };
    };
    architecture: {
      minModuleFanIn: number;
      minModuleFanOut: number;
    };
    report: {
      topFiles: number;
    };
  };
  /** V13.1 symbol locality. Shares are over consumer modules, so one heavy file never becomes the center. */
  internalLocality: {
    /** A consumer region at or above this share of consumer modules is dominant. */
    dominantShareThreshold: number;
    /** A consumer region at or above this share is a significant group; exactly two that together reach the dominant share, with none dominant, is a split. */
    significantShareThreshold: number;
    /** Below this many consumer modules the placement is `unclear`. */
    minimumConsumers: number;
    report: {
      topSymbols: number;
    };
  };
  /** V13.2 internal responsibility regions. The join rules are discrete facts; only list sizes are tunable. */
  internalResponsibilities: {
    report: {
      topRegions: number;
      topRelationships: number;
      /** Behavior-dominant modules listed per region. */
      topModules: number;
      /** Dominant symbols listed per relationship. */
      topSymbols: number;
    };
  };
  /** V13.5 package architecture review. Dominance is rule-based; these name the complex-subject cutoffs and list sizes. */
  internalReview: {
    complexSubject: {
      /** A subject is a complex review at this many nondominated alternatives… */
      minimumNondominatedAlternatives: number;
      /** …changing at least this many comparison dimensions. */
      minimumChangingDimensions: number;
    };
    report: {
      topFamilies: number;
      topSubjects: number;
    };
  };
  /** V13.4 internal rewiring scenarios. Eligibility rules are discrete; these name the thresholds and list sizes. */
  internalRewiring: {
    compositionRoot: {
      /** Placed responsibilities a module must depend on… */
      minimumResponsibilities: number;
      /** …while exporting at most this many symbols… */
      maximumExportedSymbols: number;
      /** …and constructing, rendering, collecting, or passing on at least this many bindings… */
      minimumWiringSites: number;
      /** …from at least this many responsibilities. */
      minimumWiredResponsibilities: number;
    };
    orchestration: {
      /** A module calling into several responsibilities reads as orchestration only while exporting at most this many symbols. */
      maximumExportedSymbols: number;
    };
    split: {
      /** Exported symbols a scope or role group needs to be separated on its own. */
      minimumGroupSymbols: number;
    };
    alignment: {
      /** A dedicated-role-module convention names its exceptions as outliers when its support is at least this many times its exceptions. */
      minimumSupportRatio: number;
    };
    closure: {
      /** A movement closure at or above this share of the module's declarations is large. */
      largeShare: number;
    };
    indirection: {
      /** An intermediary with one consumer, at most this many providers… */
      maximumProviders: number;
      /** …at most this many exported symbols… */
      maximumExportedSymbols: number;
      /** …and at most this many measured statements may collapse. */
      maximumStatements: number;
    };
    surface: {
      /** Distinct target modules one responsibility reaches in another before a surface is proposed… */
      minimumTargetModules: number;
      /** …carrying at least this many symbols. */
      minimumSymbols: number;
    };
    contract: {
      /** Crossing contract-family symbols declared beside behavior before a contract surface is proposed. */
      minimumSymbols: number;
    };
    /** Existing modules listed per proposal as plausible targets. */
    candidateModules: number;
    report: {
      topScenarios: number;
      topModules: number;
    };
  };
  /** V13.0 internal package topology. Graph facts need no policy; these name the path-region roots, the high-fan cutoff, and list sizes. */
  internalTopology: {
    /** Leading package-relative directories stripped before the first segment becomes the path region. */
    technicalRoots: string[];
    highFan: {
      /** A module at or above this percentile of the package's fan distribution is high-fan. */
      percentile: number;
      /** …and never below this absolute count, so tiny packages do not name a hub. */
      minimum: number;
    };
    report: {
      topModules: number;
      topSeams: number;
      topCycles: number;
      topSymbols: number;
    };
  };
  localComplexity: {
    report: {
      /** Functions listed per top-N section in the focused complexity view. */
      topFunctions: number;
    };
    decisions: {
      /** Count `&&` / `||` as decision points. */
      countLogicalOperators: boolean;
      /** Count `??` as a decision point. */
      countNullishCoalescing: boolean;
    };
  };
  opportunities: {
    foldPackage: {
      gates: {
        requiredConsumers: number;
      };
      evidence: {
        weights: {
          singleConsumer: number;
          referenceConcentration: number;
          surfaceConcentration: number;
          narrowDistribution: number;
          oneWayDependency: number;
        };
        narrowDistributionCeiling: number;
      };
    };
    preserveSharedBoundary: {
      gates: {
        minConsumers: number;
        maxPrimaryReferenceShare: number;
      };
      evidence: {
        weights: {
          multipleConsumers: number;
          lowConcentration: number;
          broadDistribution: number;
        };
        broadDistributionCeiling: number;
      };
    };
  };
  /** V13.3 primitive and convention intelligence. Role rules are discrete; these name the few thresholds and the schema libraries. */
  primitiveConventions: {
    /** Import specifiers (exact, or a subpath of) whose call results are schema declarations. */
    schemaLibraries: string[];
    packageWide: {
      /** A symbol serving at least this many responsibilities is package-wide… */
      minimumResponsibilities: number;
      /** …or this share of the package's placed responsibilities, whichever is larger. */
      responsibilityShare: number;
    };
    /** A module is dedicated to one role when that role holds at least this share of its exported classified symbols. */
    dedicatedRoleShare: number;
    hub: {
      /** Exported symbols of the hub's roles needed to call a module a hub… */
      minimumSymbols: number;
      /** …serving at least this many responsibilities. */
      minimumResponsibilities: number;
    };
    utility: {
      /** A free function with no concept relationship, at most this many measured statements… */
      maximumStatements: number;
      /** …and at least this many consumer modules is a utility. */
      minimumConsumers: number;
    };
    conventions: {
      /** Symbols a placement value needs before it counts as a convention. */
      minimumSupport: number;
    };
    /** Basenames that name a role; recorded as observed placement evidence, never used to classify. */
    roleBasenames: string[];
    report: {
      topSymbols: number;
      topModules: number;
      topConventions: number;
      /** Modules broken down symbol by symbol. */
      microscopeModules: number;
    };
  };
  /**
   * V8.0 re-centering candidates. Every gate is a count or a share; a
   * candidate needs tensions from several dimensions and one strong
   * structural tension, and history alone never makes one.
   */
  recentering: {
    candidates: {
      /** Distinct tension dimensions a candidate needs. */
      minEvidenceDimensions: number;
      /** Strong source behaviors (implementation, conversion, return) an observed behavior center must hold. */
      minStrongBehaviors: number;
    };
    /**
     * Cross-package-distributed behavior whose strong part is genuinely
     * spread. Weak behavior (accepting or constructing the concept) is
     * breadth of use, so a concept mostly used that way is not scattered.
     */
    scatter: {
      minStrongModules: number;
      minStrongPackages: number;
      /** At or above this share in the two largest strong modules the behavior reads as concentrated, not scattered. */
      maxTopTwoModuleShare: number;
      /** Above this share of weak source behavior the concept reads as broadly used, not scattered. */
      maxWeakShare: number;
    };
    /** Conversion and return behavior in packages that are neither the seed nor an implementation center. */
    implementationScatter: { minSupportingBehaviors: number };
    /**
     * A boundary two behavior packages share, heavy enough and used by the
     * concept on both sides. Strong only beside distributed locality.
     */
    boundaryFriction: {
      minImportSites: number;
      minSourceModules: number;
      /** Return behavior the foreign side must hold; implementing or converting alone is a split, not friction. */
      minForeignReturnBehaviors: number;
    };
    /** A foreign package holding most strong behavior and most import traffic into the seed module. */
    dependencyMisalignment: {
      minStrongShare: number;
      minSeedImportSiteShare: number;
    };
    temporal: { minCrossPackageCouplings: number };
    report: { topCandidates: number };
    /** V8.1: declared home against observed center of gravity. */
    miscentering: {
      /**
       * Composite gravity weights; renormalized over the families that
       * have data. Producing or governing the concept outweighs using it.
       */
      gravity: {
        weights: {
          "behavioral-locality": number;
          "symbol-distribution": number;
          "consumer-gravity": number;
        };
      };
      /** Independent evidence families a signal needs. */
      minEvidenceFamilies: number;
      /** Share at which one family reads as pointing at a package. */
      minFamilyShare: number;
      external: {
        /** Composite gravity the strongest other package must reach. */
        minAlternativeGravity: number;
        /** Its lead over the declared home. */
        minMismatch: number;
      };
      split: {
        /** Below this composite gravity no package dominates. */
        maxTopGravity: number;
        /** Packages at or above this share, and how many of them, read as divided. */
        minShare: number;
        minPackages: number;
      };
      drift: {
        /** Share of governing behavior outside the declared home. */
        minForeignShare: number;
        minForeignBehaviors: number;
      };
      report: { topFindings: number };
    };
    /** V8.2: alternative responsibility arrangements per V8.1 finding. */
    scenarios: {
      /** Governing-behavior share a package needs to be a candidate center or a consolidation destination. */
      minObservedCenterShare: number;
      /** Strongly related V7.2 families that must center in a package for it to count as a supporting-family center. */
      minSupportingFamilies: number;
      /** Generation guard, applied in kind precedence then destination name; never a ranking. */
      maxScenariosPerFinding: number;
      /** Generate `rehome-semantic-center` for drift findings and under an unobserved-conformance caution. */
      allowWeakRehome: boolean;
      report: { topFindings: number; topScenariosPerFinding: number };
    };
    /** V8.3: structural consequences per scenario. Nearly everything derives from placement; this only gates one claim. */
    impact: {
      boundary: {
        /**
         * Predict a package edge removed only when every import site and
         * every imported module on it belongs to the concept. Off, the
         * import-site side alone suffices.
         */
        requireExclusiveConceptContributionForElimination: boolean;
      };
      report: { topFindings: number; topScenariosPerFinding: number };
    };
    /** V8.4: Pareto review of the V8.3 vectors. No weights; one gate on what counts as a strict advantage. */
    review: {
      dominance: {
        /**
         * A scenario dominates only when at least one of its strict
         * advantages is `certain`. Off, a conditional advantage (a
         * predicted boundary reduction) suffices.
         */
        requireCertainEvidence: boolean;
      };
      report: { topFindings: number; topScenariosPerFinding: number };
    };
  };
  report: {
    symbolsPerConsumer: number;
    unusedExportsShown: number;
  };
  /**
   * Gates for cross-signal pressure. Every gate in a block must match for
   * the signal to fire; each block spans at least two measurement families
   * so no single metric can produce a signal.
   */
  structuralPressure: {
    surface: {
      minPackagePublicSymbols: number;
      maxExportUtilization: number;
      minPrimaryConsumerShare: number;
    };
    integration: {
      minFanOut: number;
      minDependencyReach: number;
      minOutgoingImportSites: number;
    };
    centralization: {
      minFanIn: number;
      minIncomingReferences: number;
      minDestinationConcentration: number;
    };
    internalStructure: {
      minDepthDelta: number;
      /** Fan-in of the top module whose role is internal (not an aggregator). */
      minTopInternalModuleFanIn: number;
      /** Control-flow decisions that make one function branch-heavy. */
      branchHeavyControlFlowDecisions: number;
      /** Functions at or above that bar. */
      minBranchHeavyFunctions: number;
    };
    boundary: {
      /** Broad shape: volume by sites or references, plus symbol breadth. */
      minImportSites: number;
      minReferences: number;
      minSymbols: number;
      /** Concentrated shape: moderate traffic landing mostly in one module. */
      concentratedMinImportSites: number;
      concentratedShare: number;
    };
  };
  workspaceConcepts: {
    shapes: {
      crossLayer: {
        /** Responsibility (behavior, implementation) layer span at which a concept is `cross-layer`. */
        minLayerSpan: number;
      };
    };
    report: {
      topConcepts: number;
      topDirections: number;
      topBoundaries: number;
      topPackages: number;
    };
  };
  /** V9.1 workspace graph. Raw graph metrics need no policy; these gate only the descriptive seam/corridor selections and list sizes. */
  workspaceGraph: {
    seams: {
      /** Reachable pairs beyond the edge's own endpoints that the edge alone carries. */
      minSeveredPairs: number;
      minRegionSize: number;
    };
    corridors: {
      /** Distinct package pairs whose shortest routes share the segment. */
      minSupport: number;
      /** Edges. */
      minLength: number;
      maxPathsPerPair: number;
    };
    report: {
      topPackages: number;
      topModules: number;
      topSeams: number;
      topCorridors: number;
      topChains: number;
    };
  };
  /** V9.3 workspace patterns. Recurrence minimums; a pattern below them is reported only in the threshold diagnostics. */
  workspacePatterns: {
    support: {
      /** Distinct concepts a role, pair, concept, or seam pattern needs. */
      minConcepts: number;
      /** Distinct declaring packages a package role needs. */
      minSourcePackages: number;
      /** Reviewed concepts a review overlay needs before it names a direction pattern. */
      minReviewedConcepts: number;
      /** Distinct source-source couplings an evolutionary pattern needs. */
      minCouplings: number;
      /** Cross-package conversion pairs a projection needs. */
      minConversionPairs: number;
      /** Support at this multiple of the minimum reads `strong` under complete coverage. */
      strongMultiplier: number;
    };
    consumption: {
      minConcepts: number;
      minSourcePackages: number;
    };
    boundaries: {
      minImportSites: number;
      minConcepts: number;
      /** Share of a boundary's concept load one role needs to name the channel. */
      minRoleShare: number;
    };
    report: {
      topPackages: number;
      topPairs: number;
      topBoundaries: number;
      topConceptPatterns: number;
    };
  };
}

/**
 * A primary consumer at or above this reference/surface share reads as
 * concentrated consumption. Shared by the shape signal and the preserve
 * gate: at this share a package is concentrated, not shared.
 */
const HIGH_CONCENTRATION_SHARE = 0.8;

/**
 * Control-flow decisions at which one function reads as branch-heavy. The
 * V6.1 finding: max control-flow per file was the metric that separated
 * hotspots, so the same bar names branch-heavy functions for structural
 * pressure. Expression decisions never count toward it.
 */
const BRANCH_HEAVY_CONTROL_FLOW_DECISIONS = 6;

/** Bump when tuning changes, so reports from different policies can be told apart. */
export const ANALYSIS_POLICY_VERSION = 24;

/**
 * Policy of the derived workspace layers (`workspaceGraph`,
 * `workspaceConcepts`, `workspacePatterns`). Package analysis never reads
 * those sections, so this bumps on its own.
 */
export const WORKSPACE_INTELLIGENCE_POLICY_VERSION = 2;

export const ANALYSIS_CONFIG: AnalysisConfig = {
  anchors: [
    {
      reason: "Intentional workspace subsystem boundary",
      target: "@foundry/workspaces",
    },
  ],
  architecturalProfiles: {
    broadlyConsumed: {
      maxPrimaryConsumerShare: HIGH_CONCENTRATION_SHARE,
      minConsumers: 3,
    },
    foundationLike: {
      maxFanOut: 1,
      minFanIn: 2,
    },
    integrationLike: {
      maxFanIn: 2,
      minFanOut: 3,
    },
    leafLike: {
      maxFanIn: 1,
      /** Above this the shape reads integration-like, not edge-like. */
      maxFanOut: 2,
      minFanOut: 1,
    },
    narrowlyConsumed: {
      minPrimaryConsumerShare: HIGH_CONCENTRATION_SHARE,
    },
    sharedHubLike: {
      /** Each externally-used symbol serves ~1.5 consumers on average. */
      minAverageSymbolDistribution: 1.5,
      minConsumers: 3,
      minFanIn: 3,
    },
    surfaceHeavy: {
      maxExportUtilization: 0.25,
      /** Below this a low utilization is small-number noise, not a shape. */
      minPackagePublicSymbols: 20,
    },
  },
  behavioralLocality: {
    behaviorLight: { maxSourceBehaviors: 2, minReferenceModules: 5 },
    crossPackageDistributed: {
      minModules: 6,
      minPackages: 3,
      minTraversalDistance: 2,
    },
    parallelImplementations: { minPackages: 2 },
    report: {
      topConcepts: 10,
      topExternalCompanions: 5,
      topModules: 10,
    },
    singlePackageDistributed: { minModules: 3 },
    support: { minSourceBehaviors: 1, sparseSourceBehaviors: 3 },
  },
  boundaryInteractions: {
    report: {
      topBoundaries: 5,
      topModules: 5,
    },
  },
  changeCoupling: {
    gates: {
      /**
       * Repository pair support (365-day window, non-oversized commits):
       * p50 1, p90 2, p95 3, max 35; 2,347 of 42,530 observed pairs reach 3.
       */
      minCoChangeCommits: 3,
      minConditional: 0.5,
      minJaccard: 0.3,
    },
    report: {
      topPairs: 10,
    },
  },
  changeRadius: {
    report: {
      topCombinations: 5,
      topCommits: 5,
    },
  },
  churn: {
    report: {
      topFiles: 5,
    },
    /**
     * A year keeps old development eras from dominating today's shape while
     * still spanning a full release cycle. Recency and file age always read
     * the full history regardless of the window.
     */
    windowDays: 365,
  },
  conceptDistribution: {
    referenceDistributed: {
      maxPrimaryReferenceShare: 0.5,
      minPackages: 3,
    },
    report: {
      topFamilies: 10,
      topModules: 5,
      topPackages: 5,
    },
    representationConcentrated: {
      minPrimaryShare: 0.75,
      minRepresentations: 3,
    },
  },
  conceptOverlap: {
    conversion: {
      wrappers: ["Promise", "Array", "ReadonlyArray", "Readonly", "Partial"],
    },
    gates: {
      minEvidenceDimensions: 2,
    },
    generation: {
      maxIndexFanout: 40,
    },
    name: {
      genericTokens: [
        "record",
        "data",
        "info",
        "options",
        "config",
        "input",
        "output",
        "result",
        "model",
        "dto",
        "entity",
        "type",
        "props",
        "state",
        "params",
        "context",
        "error",
        "event",
        "item",
        "view",
      ],
      minJaccard: 0.5,
    },
    properties: {
      commonNames: [
        "id",
        "name",
        "type",
        "value",
        "status",
        "kind",
        "key",
        "label",
        "title",
        "description",
        "className",
        "children",
        "disabled",
        "style",
        "onChange",
        "onClick",
      ],
      errorBaseNames: ["name", "message", "stack", "cause"],
      minJaccard: 0.5,
      minSharedProperties: 3,
    },
    report: {
      topCandidates: 10,
    },
    shapes: {
      /**
       * Same bar as the structural gate. Repository-wide, near-equivalent
       * pairs sharing 1–2 names are discriminant fragments (`{ kind }`,
       * `{ type }`) and paging inputs, not one idea in two places.
       */
      minSharedProperties: 3,
      nearEquivalentMinJaccard: 0.8,
      projectionMinSubsetShare: 0.8,
    },
  },
  conceptOwnership: {
    behaviorCenter: { fileKinds: ["source"], minBehaviors: 3, minShare: 0.5 },
    candidates: {
      minBehaviors: 2,
      minReferenceShare: 0.1,
      minRepresentations: 2,
    },
    evolutionCenter: {
      couplingContexts: ["source-source"],
      minHistoricalSupport: 3,
    },
    report: {
      topConcepts: 10,
    },
    representationCenter: {
      fileKinds: ["source"],
      minRepresentations: 3,
      minShare: 0.5,
    },
    support: {
      minBehaviors: 2,
      minReferences: 3,
    },
    tensions: {
      anchorMinConvergingDimensions: 2,
      minBehaviors: 5,
      minRepresentations: 5,
      minShare: 0.75,
    },
    usageCenter: { minReferences: 5, minShare: 0.4 },
  },
  concepts: {
    report: {
      evidenceShown: 25,
      topFamilies: 10,
      topRepresentations: 10,
    },
    seedKinds: ["interface", "class", "type", "enum"],
  },
  dependency: {
    concentration: {
      /** Distributed consumption: the primary consumer stays below this share. */
      distributedMaxShare: 0.5,
      highShare: HIGH_CONCENTRATION_SHARE,
    },
    shape: {
      distributedMinConsumers: 3,
      highFanIn: 4,
      highFanOut: 6,
    },
  },
  dependencyGravity: {
    report: {
      topModules: 5,
    },
  },
  evolutionaryPressure: {
    centralization: {
      /** Same repository-relative bar as the hotspot commit gate. */
      minCommitPercentile: 0.9,
      topSeams: 3,
    },
    coupling: {
      minFileCommits: 5,
      minPackageCommits: 10,
    },
    hotStructuralHub: {
      eligibleKinds: ["source"],
      minCommitPercentile: 0.95,
      /** Same bar as internal-structure pressure's top-module fan-in. */
      minModuleFanIn: 20,
    },
    integration: {
      /**
       * Boundary-crossing rate across 28 packages: p50 0.54, six within
       * ±0.05 of 0.5 (studio 0.488). The rate alone is brittle here, so a
       * recurring edge-connected package pair reinforces on its own; the
       * former cross-package-rate gate was implied by this one.
       */
      minBoundaryCrossingRate: 0.5,
    },
    lowEvolution: {
      maxCrossPackageRate: 0.25,
    },
    report: {
      topHubs: 5,
      topTensions: 5,
    },
    support: {
      /**
       * Eligible radius commits across 28 packages: 20 at 10 or more (two
       * exactly at 10), then templates 9, environments 8, workspaces 7, and
       * five at 3 or fewer. Kept at 10 rather than lowered to admit the
       * two just under it.
       */
      minCommits: 10,
    },
  },
  history: {
    composition: {
      configDominantMinShare: 0.5,
      sourceDominantMaxConfigShare: 0.25,
    },
    /** Tests, stories, and config legitimately ride along with source. */
    eligibleKinds: ["source", "test", "story", "config"],
    oversized: {
      /**
       * Config-dominant commits with ≥ 5 packages (12 observed) are version
       * bumps and tooling sweeps: 30 files over 26 packages, 21 over 17.
       * They stay in churn but never read as cross-package evolution.
       */
      configSweepMinPackages: 5,
      /**
       * Window commits (1,013): code files (source + test + story) p50 5,
       * p90 25, p95 38, max 258. 40 sits just above p95 and keeps mass
       * refactors and generated refreshes (44 commits) out of pair and
       * radius distributions; config riders no longer push a commit over.
       */
      maxCodeFilesPerCommit: 40,
    },
  },
  hotspots: {
    architecture: {
      /** Same bar as internal-structure pressure's top-module fan-in. */
      minModuleFanIn: 20,
      /** Observed @foundry/db module fan-out: p50 2, p95 8, max 16. */
      minModuleFanOut: 10,
    },
    eligibleKinds: ["source"],
    gates: {
      complexity: {
        minFunctionsForDense: 5,
        minMaxControlFlowDecisions: BRANCH_HEAVY_CONTROL_FLOW_DECISIONS,
        /**
         * Hot repository files (200 above the commit gate): max nesting p90
         * 3, p95 3, max 4, 26 files exactly at 3. At 3 the gate admitted six
         * files with ≤ 4 control-flow decisions; every file at 4 is already
         * branch-heavy, so 4 keeps `deep-control-flow` descriptive.
         */
        minMaxNesting: 4,
        minTotalControlFlowDecisions: 15,
      },
      /**
       * Repository source files (365-day window, stories excluded):
       * commits/file p50 2, p90 7, p95 10. At 0.9 a file needs 9 commits
       * here — 8 lands at 0.897, so the step just under the gate holds 62
       * files. Repository-relative by design; the step is the cost.
       */
      minCommitPercentile: 0.9,
    },
    report: {
      topFiles: 10,
    },
  },
  internalLocality: {
    dominantShareThreshold: 0.6,
    minimumConsumers: 2,
    report: {
      topSymbols: 8,
    },
    significantShareThreshold: 0.1,
  },
  internalResponsibilities: {
    report: {
      topModules: 3,
      topRegions: 8,
      topRelationships: 8,
      topSymbols: 3,
    },
  },
  internalReview: {
    complexSubject: {
      minimumChangingDimensions: 3,
      minimumNondominatedAlternatives: 2,
    },
    report: {
      topFamilies: 6,
      topSubjects: 5,
    },
  },
  internalRewiring: {
    alignment: {
      minimumSupportRatio: 4,
    },
    candidateModules: 3,
    closure: {
      largeShare: 0.5,
    },
    compositionRoot: {
      maximumExportedSymbols: 3,
      minimumResponsibilities: 3,
      minimumWiredResponsibilities: 2,
      minimumWiringSites: 2,
    },
    contract: {
      minimumSymbols: 2,
    },
    indirection: {
      maximumExportedSymbols: 2,
      maximumProviders: 1,
      maximumStatements: 15,
    },
    orchestration: {
      maximumExportedSymbols: 6,
    },
    report: {
      topModules: 5,
      topScenarios: 8,
    },
    split: {
      minimumGroupSymbols: 2,
    },
    surface: {
      minimumSymbols: 3,
      minimumTargetModules: 3,
    },
  },
  internalTopology: {
    highFan: {
      minimum: 3,
      percentile: 0.9,
    },
    report: {
      topCycles: 5,
      topModules: 8,
      topSeams: 8,
      topSymbols: 8,
    },
    technicalRoots: ["src", "source", "lib"],
  },
  localComplexity: {
    decisions: {
      /**
       * Short-circuit `&&`/`||` create real alternate evaluation paths;
       * `??` usually reads as a default value, not a decision.
       */
      countLogicalOperators: true,
      countNullishCoalescing: false,
    },
    report: {
      topFunctions: 5,
    },
  },
  opportunities: {
    foldPackage: {
      evidence: {
        /**
         * Average symbol distribution at or above this contributes zero
         * narrowness; at the natural floor of 1 it contributes fully.
         */
        narrowDistributionCeiling: 2,
        weights: {
          narrowDistribution: 0.15,
          oneWayDependency: 0.15,
          referenceConcentration: 0.2,
          singleConsumer: 0.3,
          surfaceConcentration: 0.2,
        },
      },
      gates: {
        /**
         * Hard gate: fold-package requires exactly one consumer package. A
         * multi-consumer package never folds, however concentrated its usage.
         */
        requiredConsumers: 1,
      },
    },
    preserveSharedBoundary: {
      evidence: {
        /**
         * Average symbol distribution at or above this contributes full
         * breadth; at the natural floor of 1 it contributes nothing.
         */
        broadDistributionCeiling: 2,
        weights: {
          broadDistribution: 0.25,
          lowConcentration: 0.35,
          multipleConsumers: 0.4,
        },
      },
      gates: {
        /**
         * A dominant consumer at or above this reference share prevents
         * preserve classification while the raw concentration measurements
         * stay visible. Surface share is deliberately not gated — one
         * consumer touching the whole surface is normal for small shared
         * packages.
         */
        maxPrimaryReferenceShare: HIGH_CONCENTRATION_SHARE,
        /**
         * Require multiple independent consumers before treating a package
         * as a shared boundary. Deliberately distinct from the
         * distributed-consumption shape signal's minimum.
         */
        minConsumers: 3,
      },
    },
  },
  primitiveConventions: {
    conventions: {
      minimumSupport: 3,
    },
    dedicatedRoleShare: 0.8,
    hub: {
      minimumResponsibilities: 2,
      minimumSymbols: 4,
    },
    packageWide: {
      minimumResponsibilities: 3,
      responsibilityShare: 0.1,
    },
    report: {
      microscopeModules: 3,
      topConventions: 8,
      topModules: 8,
      topSymbols: 8,
    },
    roleBasenames: [
      "types",
      "constants",
      "config",
      "schema",
      "schemas",
      "contracts",
      "utils",
      "helpers",
      "shared",
    ],
    schemaLibraries: [
      "zod",
      "valibot",
      "yup",
      "arktype",
      "superstruct",
      "@sinclair/typebox",
      "@effect/schema",
      "effect/Schema",
      "drizzle-orm",
    ],
    utility: {
      maximumStatements: 15,
      minimumConsumers: 2,
    },
  },
  recentering: {
    boundaryFriction: {
      minForeignReturnBehaviors: 2,
      minImportSites: 20,
      minSourceModules: 3,
    },
    candidates: { minEvidenceDimensions: 2, minStrongBehaviors: 3 },
    dependencyMisalignment: {
      minSeedImportSiteShare: 0.5,
      minStrongShare: 0.75,
    },
    impact: {
      boundary: { requireExclusiveConceptContributionForElimination: true },
      report: { topFindings: 5, topScenariosPerFinding: 4 },
    },
    implementationScatter: { minSupportingBehaviors: 2 },
    miscentering: {
      drift: { minForeignBehaviors: 3, minForeignShare: 0.5 },
      external: { minAlternativeGravity: 0.5, minMismatch: 0.25 },
      gravity: {
        weights: {
          "behavioral-locality": 0.6,
          "consumer-gravity": 0.15,
          "symbol-distribution": 0.25,
        },
      },
      minEvidenceFamilies: 2,
      minFamilyShare: 0.5,
      report: { topFindings: 5 },
      split: { maxTopGravity: 0.5, minPackages: 2, minShare: 0.2 },
    },
    report: { topCandidates: 10 },
    review: {
      dominance: { requireCertainEvidence: true },
      report: { topFindings: 5, topScenariosPerFinding: 4 },
    },
    scatter: {
      maxTopTwoModuleShare: 0.8,
      maxWeakShare: 0.5,
      minStrongModules: 3,
      minStrongPackages: 2,
    },
    scenarios: {
      allowWeakRehome: false,
      maxScenariosPerFinding: 6,
      minObservedCenterShare: 0.2,
      minSupportingFamilies: 2,
      report: { topFindings: 5, topScenariosPerFinding: 4 },
    },
    temporal: { minCrossPackageCouplings: 1 },
  },
  report: {
    /** Symbols listed per consumer in the terminal report. */
    symbolsPerConsumer: 4,
    /** Unused external exports listed before "… N more". */
    unusedExportsShown: 10,
  },
  structuralPressure: {
    boundary: {
      concentratedMinImportSites: 20,
      concentratedShare: 0.5,
      minImportSites: 50,
      minReferences: 100,
      minSymbols: 25,
    },
    centralization: {
      /**
       * Top declaring module's share of all incoming import sites (summed
       * across consumers). Observed: ui 11.8%, environments ~21%, db 24.9%.
       */
      minDestinationConcentration: 0.2,
      minFanIn: 3,
      minIncomingReferences: 100,
    },
    integration: {
      /** Observed dependency reach: db 20.4%, ui 13.2%, workspaces 3.7%. */
      minDependencyReach: 0.1,
      minFanOut: 3,
      /** Observed outgoing sites: db 221, ui 23, workspaces 21. */
      minOutgoingImportSites: 50,
    },
    internalStructure: {
      branchHeavyControlFlowDecisions: BRANCH_HEAVY_CONTROL_FLOW_DECISIONS,
      /**
       * Functions with ≥ 6 control-flow decisions per package: 0–1 for
       * twelve packages, then 3, 3, 4, 6, 7, 11 … 73. Nothing sits at 2.
       * Replaces total-decisions p95 (23/28 cleared 3; expression decisions
       * were counted).
       */
      minBranchHeavyFunctions: 3,
      /**
       * Module depth minus package depth across 28 packages: p50 12, 16
       * clear 10. Weak alone (package depth never exceeds 4, so the delta is
       * mostly module depth); the other two gates do the separating.
       */
      minDepthDelta: 10,
      /**
       * Top fan-in among internal source modules: with barrels and test
       * files excluded the top module is an internal center (ui's four-line
       * `cn` index 277, workflows step.ts 63, config.ts 34) rather than a
       * re-export file (workflows store.ts, fan-in 68, is a two-line
       * barrel). db sits at 19 (tasks/contracts.ts) — marginal.
       */
      minTopInternalModuleFanIn: 20,
    },
    surface: {
      maxExportUtilization: 0.25,
      /**
       * Observed package-public counts: @foundry/ui 4431, db 353,
       * environments 88, workspaces 73, lib 7. 50 keeps small utilities out.
       */
      minPackagePublicSymbols: 50,
      minPrimaryConsumerShare: HIGH_CONCENTRATION_SHARE,
    },
  },
  workspaceConcepts: {
    report: {
      topBoundaries: 10,
      topConcepts: 10,
      topDirections: 10,
      topPackages: 10,
    },
    shapes: {
      crossLayer: {
        minLayerSpan: 2,
      },
    },
  },
  workspaceGraph: {
    corridors: {
      maxPathsPerPair: 32,
      minLength: 2,
      minSupport: 2,
    },
    report: {
      topChains: 5,
      topCorridors: 10,
      topModules: 10,
      topPackages: 10,
      topSeams: 10,
    },
    seams: {
      /** Both weak sides of a bridge must be at least this large; a pendant leaf is not a seam. */
      minRegionSize: 2,
      minSeveredPairs: 1,
    },
  },
  workspacePatterns: {
    boundaries: {
      /** Real sweep: 20 → 15 is the widest gap in the concept-load distribution. */
      minConcepts: 20,
      /** Real sweep: 109 → 95 is the widest gap in the import-site distribution. */
      minImportSites: 100,
      minRoleShare: 0.5,
    },
    consumption: {
      /** Consumption is broad by nature; a handful of foreign concepts from one neighbor is ordinary use. */
      minConcepts: 10,
      minSourcePackages: 3,
    },
    report: {
      topBoundaries: 10,
      topConceptPatterns: 10,
      topPackages: 10,
      topPairs: 10,
    },
    support: {
      minConcepts: 3,
      minConversionPairs: 3,
      minCouplings: 3,
      minReviewedConcepts: 2,
      minSourcePackages: 2,
      strongMultiplier: 2,
    },
  },
};
