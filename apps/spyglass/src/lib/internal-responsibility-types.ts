import type { InternalModuleRole } from "./internal-topology-types";
import type { ConceptRelationshipKind, SymbolKind } from "./types";

export const INTERNAL_RESPONSIBILITY_SCHEMA_VERSION = 1;

export type ResponsibilityEvidenceKind =
  | "path"
  | "dependency"
  | "cycle"
  | "concept"
  | "behavior"
  | "symbol-flow"
  | "seam";

export type ResponsibilityJoinReason =
  | "concept-flow"
  | "directory-dependency"
  | "directory-fallback";

export interface ResponsibilityUnit {
  cycle?: string;
  id: string;
  kind: "cycle" | "module";
  modules: string[];
}

export interface ResponsibilityJoin {
  left: string;
  reasons: ResponsibilityJoinReason[];
  right: string;
  symbols: string[];
}

export type ResponsibilityPathAgreement =
  | "matches-path-region"
  | "within-path-region"
  | "spans-path-regions";

export type ResponsibilityLabelBasis = "directory" | "concept" | "module";

export interface ResponsibilityConceptEntry {
  conceptId: string;
  modules: number;
  name: string;
  relationships: ConceptRelationshipKind[];
}

export interface ResponsibilityRegion {
  attached: string[];
  behavior: {
    mass: number;
    bearingModules: number;
    dominantModules: { module: string; statements: number; share: number }[];
    conceptOwnedMass: number;
    conceptOwners: string[];
  };
  concepts: {
    declared: ResponsibilityConceptEntry[];
    referenced: ResponsibilityConceptEntry[];
  };
  construction: {
    joins: ResponsibilityJoin[];
    joinsByReason: Record<ResponsibilityJoinReason, number>;
  };
  evidence: ResponsibilityEvidenceKind[];
  id: string;
  label: string;
  labelBasis: ResponsibilityLabelBasis;
  modules: string[];
  path: {
    directories: string[];
    pathRegions: string[];
    dominantDirectory: { id: string; modules: number; share: number };
    agreement: ResponsibilityPathAgreement;
  };
  symbols: {
    declared: number;
    local: number;
    crossing: number;
    consumedFromOutside: number;
    distributedConsumed: number;
    behaviorDisagreesWithUsage: number;
  };
  topology: {
    internalEdges: number;
    inboundEdges: number;
    outboundEdges: number;
    cycles: string[];
    layerSpan: { min: number; max: number };
    dependencySources: number;
    dependencySinks: number;
    roles: Partial<Record<InternalModuleRole, number>>;
  };
  units: string[];
}

export interface ResponsibilityRelationship {
  concepts: string[];
  dominantSymbols: { name: string; symbolId?: string; importSites: number }[];
  from: string;
  importSites: number;
  mediatedEdges: number;
  moduleEdges: number;
  pathRegions: { within: number; across: number };
  sourceModules: string[];
  symbolFlow: number;
  targetModules: string[];
  to: string;
}

export type ResponsibilityAmbiguityReason =
  | "aggregator"
  | "distributed-primitive"
  | "wide-dependent"
  | "bridge";

export interface ResponsibilityCandidate {
  edges: number;
  localizedSymbols: number;
  region: string;
}

export interface ResponsibilityAmbiguity {
  candidates: ResponsibilityCandidate[];
  module: string;
  reason: ResponsibilityAmbiguityReason;
  roles: InternalModuleRole[];
}

export type ResponsibilityModuleStatus = "assigned" | "attached" | "unresolved";

export interface ResponsibilityAffinity {
  edges: number;
  kinds: ("dependency" | "concept")[];
  region: string;
}

export interface ResponsibilityModuleEvidence {
  affinities: ResponsibilityAffinity[];
  behaviorMass: number;
  concepts: { declared: number; participating: number };
  connector: boolean;
  cycle?: string;
  directory: string;
  localizedSymbols: { declared: number; consumed: number };
  module: string;
  pathAgreesWithRegion?: boolean;
  pathRegion: string;
  region?: string;
  roles: InternalModuleRole[];
  status: ResponsibilityModuleStatus;
  unit: string;
}

export type ResponsibilitySymbolLocality =
  | "responsibility-local"
  | "responsibility-crossing"
  | "unplaced";

export interface ResponsibilitySymbolContext {
  conceptSeed: boolean;
  consumerModules: number;
  consumerRegions: string[];
  declarationRegion?: string;
  kind: SymbolKind;
  locality: ResponsibilitySymbolLocality;
  name: string;
  symbolId: string;
  unresolvedConsumers: number;
}

export interface ResponsibilityPathSeamComparison {
  acrossResponsibilities: number;
  from: string;
  moduleEdges: number;
  to: string;
  unresolved: number;
  withinResponsibility: number;
}

export interface InternalResponsibilitySummary {
  assignedModules: number;
  attachedModules: number;
  behaviorBearingRegions: number;
  behaviorLightRegions: number;
  behaviorMass: { total: number; topRegionShare: number };
  byLabelBasis: Record<ResponsibilityLabelBasis, number>;
  byPathAgreement: Record<ResponsibilityPathAgreement, number>;
  connectors: number;
  cycleUnits: number;
  joinsByReason: Record<ResponsibilityJoinReason, number>;
  largestRegion: number;
  multiModuleRegions: number;
  pathRegionsSplit: number;
  pathSeamsCollapsed: number;
  primaryModules: number;
  regionCycles: number;
  regions: number;
  regionsWithDeclaredConcepts: number;
  regionsWithoutConcepts: number;
  regionsWithSeveralConcepts: number;
  relationships: number;
  relationshipsHiddenInPathRegions: number;
  responsibilitiesSpanningDirectories: number;
  responsibilitiesSpanningPaths: number;
  singleModuleRegions: number;
  symbols: Record<ResponsibilitySymbolLocality, number>;
  units: number;
  unresolvedByReason: Record<ResponsibilityAmbiguityReason, number>;
  unresolvedModules: number;
}

interface InternalResponsibilityPolicy {
  attachment: "a connector joins the one region its localized-symbol edges reach, else the one region any edge reaches; several regions leave it unresolved";
  bridge: "a bridge-role module with no join and localized-symbol edges into several regions is unresolved";
  connectorRoles: InternalModuleRole[];
  identity: "sha256 over the sorted member modules";
  joins: Record<ResponsibilityJoinReason, string>;
  label: "the shared directory below the root; else the declared concept with the most region participants; else the highest fan-in module";
  localizedSymbol: "a consumed symbol below the cutoff whose locality is neither package-distributed nor split";
  localizedSymbolCutoff: number;
  order: "modules descending, then first module";
  technicalRoots: string[];
  unit: "nontrivial cycle, else one primary module";
}

export interface InternalResponsibilityReport {
  limitations: string[];
  modules: ResponsibilityModuleEvidence[];
  package: { id: string; root: string };
  pathSeams: ResponsibilityPathSeamComparison[];
  policy: InternalResponsibilityPolicy;
  regionCycles: string[][];
  regions: ResponsibilityRegion[];
  relationships: ResponsibilityRelationship[];
  schemaVersion: typeof INTERNAL_RESPONSIBILITY_SCHEMA_VERSION;
  summary: InternalResponsibilitySummary;
  symbols: ResponsibilitySymbolContext[];
  units: ResponsibilityUnit[];
  unresolved: ResponsibilityAmbiguity[];
}
