import type { InternalDistribution } from "./internal-topology-types";
import type { SymbolKind } from "./types";

export const SYMBOL_LOCALITY_SCHEMA_VERSION = 1;

export type ArchitecturalScopeKind =
  | "module"
  | "directory"
  | "region"
  | "package";

export interface ArchitecturalScope {
  id: string;
  kind: ArchitecturalScopeKind;
  modules: string[];
  parent?: string;
  path: string;
}

export interface ArchitecturalScopeRef {
  id: string;
  kind: ArchitecturalScopeKind;
  path: string;
}

export interface LocalityShare {
  bindingOccurrences: number;
  bindingShare: number;
  id: string;
  importSiteShare: number;
  importSites: number;
  modules: number;
  share: number;
}

export type SymbolDistributionShape =
  | "module-localized"
  | "directory-localized"
  | "region-localized"
  | "multi-region"
  | "package-distributed";

export type DeclarationPlacement =
  | "aligned"
  | "broader-than-consumers"
  | "narrower-than-consumers"
  | "cross-region"
  | "cross-directory"
  | "split"
  | "distributed"
  | "unclear";

export type DirectoryRelationship =
  | "same"
  | "ancestor"
  | "descendant"
  | "disjoint";

export type SymbolUsage = "type" | "value" | "both";

export type DeclarationShape = "behavior" | "contract" | "value";

export type SymbolLocalityLimitation =
  | "single-consumer"
  | "namespace-member-derived"
  | "namespace-bare-use";

export type SymbolLocalityEvidence = "complete" | "partial" | "limited";

export interface RegionShare extends LocalityShare {
  significant: boolean;
}

export interface SymbolLocalityFinding {
  behavior: {
    declarationShape: DeclarationShape;
    declarationFunctions: number;
    consumerStatements: number;
    dominantBehaviorRegion?: { id: string; share: number };
    agreesWithUsage?: boolean;
  };
  commonDirectory: { path: string; depth: number };
  commonScope: ArchitecturalScopeRef;
  conceptSeed: boolean;
  consumerModules: string[];
  consumers: {
    modules: number;
    directories: number;
    regions: number;
    importSites: number;
    namespaceSites: number;
    bindingOccurrences: number;
    mediated: number;
    typeOnly: number;
  };
  declaration: {
    module: string;
    directory: string;
    region: string;
    depth: number;
    scope: ArchitecturalScopeRef;
  };
  directoryRelationship: DirectoryRelationship;
  distribution: SymbolDistributionShape;
  dominantDirectory: LocalityShare;
  dominantModule: LocalityShare;
  dominantRegion?: RegionShare;
  evidence: SymbolLocalityEvidence;
  exported: boolean;
  kind: SymbolKind;
  limitations: SymbolLocalityLimitation[];
  name: string;
  packagePublic: boolean;
  placement: DeclarationPlacement;
  regions: RegionShare[];
  seams: {
    crossed: string[];
    crossRegionConsumers: number;
    crossRegionShare: number;
  };
  significantRegions: number;
  structure: {
    consumerComponents: number;
    layerSpan: { min: number; max: number };
    cycle?: { id: string; consumerShare: number; declarationMember: boolean };
    bridgeConsumerShare: number;
    aggregatorConsumerShare: number;
  };
  symbolId: string;
  topRegion: RegionShare;
  usage: SymbolUsage;
}

export interface SymbolLocalitySummary {
  anonymousDefaultExports: number;
  bareNamespaceSites: number;
  behaviorDisagreesWithUsage: number;
  byDeclarationShape: Record<DeclarationShape, number>;
  byDistribution: Record<SymbolDistributionShape, number>;
  byPlacement: Record<DeclarationPlacement, number>;
  byUsage: Record<SymbolUsage, number>;
  conceptSeeds: number;
  crossSeamSymbols: number;
  distributions: {
    consumerModules: InternalDistribution;
    consumerDirectories: InternalDistribution;
    consumerRegions: InternalDistribution;
    topRegionShare: InternalDistribution;
  };
  limitations: Record<SymbolLocalityLimitation, number>;
  packagePublic: number;
  symbols: number;
  unresolvedDefaultImportSites: number;
}

interface SymbolLocalityPolicy {
  commonScope: "deepest common consumer directory; the region when that directory is the root or a technical root; the package across regions";
  dominanceDenominator: "consumer modules";
  dominantShareThreshold: number;
  minimumConsumers: number;
  significantShareThreshold: number;
  technicalRoots: string[];
}

export interface SymbolLocalityReport {
  limitations: string[];
  package: { id: string; root: string };
  policy: SymbolLocalityPolicy;
  schemaVersion: typeof SYMBOL_LOCALITY_SCHEMA_VERSION;
  scopes: ArchitecturalScope[];
  summary: SymbolLocalitySummary;
  symbols: SymbolLocalityFinding[];
}
