import type { ChurnFileKind, ConceptSeedKind, CouplingContext } from "./types";

export interface AnchorDefinition {
  reason?: string;
  target: string;
}

export interface AnalysisConfig {
  anchors: AnchorDefinition[];
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
  behavioralLocality: {
    support: {
      minSourceBehaviors: number;
      sparseSourceBehaviors: number;
    };
    behaviorLight: {
      maxSourceBehaviors: number;
      minReferenceModules: number;
    };
    singlePackageDistributed: { minModules: number };
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
  boundaryInteractions: {
    report: {
      topBoundaries: number;
      topModules: number;
    };
  };
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
    windowDays: number | null;
    report: {
      topFiles: number;
    };
  };
  conceptDistribution: {
    referenceDistributed: {
      minPackages: number;
      maxPrimaryReferenceShare: number;
    };
    representationConcentrated: {
      minRepresentations: number;
      minPrimaryShare: number;
    };
    report: {
      topFamilies: number;
      topPackages: number;
      topModules: number;
    };
  };
  conceptOverlap: {
    name: {
      genericTokens: string[];
      minJaccard: number;
    };
    properties: {
      commonNames: string[];
      minSharedProperties: number;
      minJaccard: number;
      errorBaseNames: string[];
    };
    generation: {
      maxIndexFanout: number;
    };
    conversion: {
      wrappers: string[];
    };
    shapes: {
      nearEquivalentMinJaccard: number;
      minSharedProperties: number;
      projectionMinSubsetShare: number;
    };
    gates: {
      minEvidenceDimensions: number;
    };
    report: {
      topCandidates: number;
    };
  };
  conceptOwnership: {
    candidates: {
      minReferenceShare: number;
      minRepresentations: number;
      minBehaviors: number;
    };
    support: {
      minReferences: number;
      minBehaviors: number;
    };
    representationCenter: {
      minShare: number;
      minRepresentations: number;
      fileKinds: ChurnFileKind[];
    };
    usageCenter: { minShare: number; minReferences: number };
    behaviorCenter: {
      minShare: number;
      minBehaviors: number;
      fileKinds: ChurnFileKind[];
    };
    evolutionCenter: {
      minHistoricalSupport: number;
      couplingContexts: CouplingContext[];
    };
    tensions: {
      minShare: number;
      minRepresentations: number;
      minBehaviors: number;
      anchorMinConvergingDimensions: number;
    };
    report: {
      topConcepts: number;
    };
  };
  concepts: {
    seedKinds: ConceptSeedKind[];
    report: {
      topFamilies: number;
      topRepresentations: number;
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
      topModules: number;
    };
  };
  evolutionaryPressure: {
    support: {
      minCommits: number;
    };
    integration: {
      minBoundaryCrossingRate: number;
    };
    coupling: {
      minPackageCommits: number;
      minFileCommits: number;
    };
    centralization: {
      topSeams: number;
      minCommitPercentile: number;
    };
    hotStructuralHub: {
      eligibleKinds: ChurnFileKind[];
      minCommitPercentile: number;
      minModuleFanIn: number;
    };
    lowEvolution: {
      maxCrossPackageRate: number;
    };
    report: {
      topTensions: number;
      topHubs: number;
    };
  };
  history: {
    eligibleKinds: ChurnFileKind[];
    composition: {
      configDominantMinShare: number;
      sourceDominantMaxConfigShare: number;
    };
    oversized: {
      maxCodeFilesPerCommit: number;
      configSweepMinPackages: number;
    };
  };
  hotspots: {
    eligibleKinds: ChurnFileKind[];
    gates: {
      minCommitPercentile: number;
      complexity: {
        minMaxControlFlowDecisions: number;
        minMaxNesting: number;
        minTotalControlFlowDecisions: number;
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
  internalLocality: {
    dominantShareThreshold: number;
    significantShareThreshold: number;
    minimumConsumers: number;
    report: {
      topSymbols: number;
    };
  };
  internalResponsibilities: {
    report: {
      topRegions: number;
      topRelationships: number;
      topModules: number;
      topSymbols: number;
    };
  };
  internalReview: {
    complexSubject: {
      minimumNondominatedAlternatives: number;
      minimumChangingDimensions: number;
    };
    report: {
      topFamilies: number;
      topSubjects: number;
    };
  };
  internalRewiring: {
    compositionRoot: {
      minimumResponsibilities: number;
      maximumExportedSymbols: number;
      minimumWiringSites: number;
      minimumWiredResponsibilities: number;
    };
    orchestration: {
      maximumExportedSymbols: number;
    };
    split: {
      minimumGroupSymbols: number;
    };
    alignment: {
      minimumSupportRatio: number;
    };
    closure: {
      largeShare: number;
    };
    indirection: {
      maximumProviders: number;
      maximumExportedSymbols: number;
      maximumStatements: number;
    };
    surface: {
      minimumTargetModules: number;
      minimumSymbols: number;
    };
    contract: {
      minimumSymbols: number;
    };
    candidateModules: number;
    report: {
      topScenarios: number;
      topModules: number;
    };
  };
  internalTopology: {
    technicalRoots: string[];
    highFan: {
      percentile: number;
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
      topFunctions: number;
    };
    decisions: {
      countLogicalOperators: boolean;
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
  primitiveConventions: {
    schemaLibraries: string[];
    packageWide: {
      minimumResponsibilities: number;
      responsibilityShare: number;
    };
    dedicatedRoleShare: number;
    hub: {
      minimumSymbols: number;
      minimumResponsibilities: number;
    };
    utility: {
      maximumStatements: number;
      minimumConsumers: number;
    };
    conventions: {
      minimumSupport: number;
    };
    roleBasenames: string[];
    report: {
      topSymbols: number;
      topModules: number;
      topConventions: number;
      microscopeModules: number;
    };
  };
  recentering: {
    candidates: {
      minEvidenceDimensions: number;
      minStrongBehaviors: number;
    };
    scatter: {
      minStrongModules: number;
      minStrongPackages: number;
      maxTopTwoModuleShare: number;
      maxWeakShare: number;
    };
    implementationScatter: { minSupportingBehaviors: number };
    boundaryFriction: {
      minImportSites: number;
      minSourceModules: number;
      minForeignReturnBehaviors: number;
    };
    dependencyMisalignment: {
      minStrongShare: number;
      minSeedImportSiteShare: number;
    };
    temporal: { minCrossPackageCouplings: number };
    report: { topCandidates: number };
    miscentering: {
      gravity: {
        weights: {
          "behavioral-locality": number;
          "symbol-distribution": number;
          "consumer-gravity": number;
        };
      };
      minEvidenceFamilies: number;
      minFamilyShare: number;
      external: {
        minAlternativeGravity: number;
        minMismatch: number;
      };
      split: {
        maxTopGravity: number;
        minShare: number;
        minPackages: number;
      };
      drift: {
        minForeignShare: number;
        minForeignBehaviors: number;
      };
      report: { topFindings: number };
    };
    scenarios: {
      minObservedCenterShare: number;
      minSupportingFamilies: number;
      maxScenariosPerFinding: number;
      allowWeakRehome: boolean;
      report: { topFindings: number; topScenariosPerFinding: number };
    };
    impact: {
      boundary: {
        requireExclusiveConceptContributionForElimination: boolean;
      };
      report: { topFindings: number; topScenariosPerFinding: number };
    };
    review: {
      dominance: {
        requireCertainEvidence: boolean;
      };
      report: { topFindings: number; topScenariosPerFinding: number };
    };
  };
  report: {
    symbolsPerConsumer: number;
    unusedExportsShown: number;
  };
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
      minTopInternalModuleFanIn: number;
      branchHeavyControlFlowDecisions: number;
      minBranchHeavyFunctions: number;
    };
    boundary: {
      minImportSites: number;
      minReferences: number;
      minSymbols: number;
      concentratedMinImportSites: number;
      concentratedShare: number;
    };
  };
  workspaceConcepts: {
    shapes: {
      crossLayer: {
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
  workspaceGraph: {
    seams: {
      minSeveredPairs: number;
      minRegionSize: number;
    };
    corridors: {
      minSupport: number;
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
  workspacePatterns: {
    support: {
      minConcepts: number;
      minSourcePackages: number;
      minReviewedConcepts: number;
      minCouplings: number;
      minConversionPairs: number;
      strongMultiplier: number;
    };
    consumption: {
      minConcepts: number;
      minSourcePackages: number;
    };
    boundaries: {
      minImportSites: number;
      minConcepts: number;
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

const HIGH_CONCENTRATION_SHARE = 0.8;

const BRANCH_HEAVY_CONTROL_FLOW_DECISIONS = 6;

export const ANALYSIS_POLICY_VERSION = 27;

export const WORKSPACE_INTELLIGENCE_POLICY_VERSION = 2;

export const ANALYSIS_CONFIG: AnalysisConfig = {
  anchors: [],
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
      maxFanOut: 2,
      minFanOut: 1,
    },
    narrowlyConsumed: {
      minPrimaryConsumerShare: HIGH_CONCENTRATION_SHARE,
    },
    sharedHubLike: {
      minAverageSymbolDistribution: 1.5,
      minConsumers: 3,
      minFanIn: 3,
    },
    surfaceHeavy: {
      maxExportUtilization: 0.25,
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
      minModuleFanIn: 20,
    },
    integration: {
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
      minCommits: 10,
    },
  },
  history: {
    composition: {
      configDominantMinShare: 0.5,
      sourceDominantMaxConfigShare: 0.25,
    },
    eligibleKinds: ["source", "test", "story", "config"],
    oversized: {
      configSweepMinPackages: 5,
      maxCodeFilesPerCommit: 40,
    },
  },
  hotspots: {
    architecture: {
      minModuleFanIn: 20,
      minModuleFanOut: 10,
    },
    eligibleKinds: ["source"],
    gates: {
      complexity: {
        minFunctionsForDense: 5,
        minMaxControlFlowDecisions: BRANCH_HEAVY_CONTROL_FLOW_DECISIONS,
        minMaxNesting: 4,
        minTotalControlFlowDecisions: 15,
      },
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
        requiredConsumers: 1,
      },
    },
    preserveSharedBoundary: {
      evidence: {
        broadDistributionCeiling: 2,
        weights: {
          broadDistribution: 0.25,
          lowConcentration: 0.35,
          multipleConsumers: 0.4,
        },
      },
      gates: {
        maxPrimaryReferenceShare: HIGH_CONCENTRATION_SHARE,
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
    symbolsPerConsumer: 4,
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
      minDestinationConcentration: 0.2,
      minFanIn: 3,
      minIncomingReferences: 100,
    },
    integration: {
      minDependencyReach: 0.1,
      minFanOut: 3,
      minOutgoingImportSites: 50,
    },
    internalStructure: {
      branchHeavyControlFlowDecisions: BRANCH_HEAVY_CONTROL_FLOW_DECISIONS,
      minBranchHeavyFunctions: 3,
      minDepthDelta: 10,
      minTopInternalModuleFanIn: 20,
    },
    surface: {
      maxExportUtilization: 0.25,
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
      minRegionSize: 2,
      minSeveredPairs: 1,
    },
  },
  workspacePatterns: {
    boundaries: {
      minConcepts: 20,
      minImportSites: 100,
      minRoleShare: 0.5,
    },
    consumption: {
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
