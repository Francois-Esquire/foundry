import type {
  ResponsibilityAmbiguityReason,
  ResponsibilityModuleStatus,
  ResponsibilitySymbolLocality,
} from "./internal-responsibility-types";
import type {
  DeclarationPlacement,
  SymbolDistributionShape,
  SymbolUsage,
} from "./symbol-locality-types";
import type { SymbolKind } from "./types";

export const PRIMITIVE_CONVENTION_SCHEMA_VERSION = 1;

export type ArchitecturalRole =
  | "identifier"
  | "constant"
  | "configuration"
  | "contract"
  | "schema"
  | "factory"
  | "adapter"
  | "implementation"
  | "representation"
  | "utility"
  | "behavior"
  | "type"
  | "value"
  | "unknown";

export type ArchitecturalScopeClass =
  | "module-local"
  | "responsibility-local"
  | "cross-responsibility"
  | "package-wide"
  | "unplaced"
  | "unclear";

type RoleEvidenceKind =
  | "declaration-kind"
  | "initializer"
  | "members"
  | "alias-shape"
  | "concept-relationship"
  | "annotation"
  | "type-query"
  | "schema-library"
  | "behavior"
  | "usage"
  | "naming";

export interface RoleEvidence {
  detail: string;
  kind: RoleEvidenceKind;
  role: ArchitecturalRole;
}

export type ScopeEvidence = "complete" | "partial" | "structural" | "none";

export type PrimitiveLimitation =
  | "intra-module-usage-unmeasured"
  | "unresolved-consumers"
  | "no-internal-consumers"
  | "declaration-unplaced"
  | "namespace-derived";

export type PlacementModuleShape =
  | "dedicated-role-module"
  | "mixed-role-module";

export type PlacementDirectoryShape =
  | "package-root"
  | "dedicated-role-directory"
  | "outside-responsibility"
  | "responsibility-root"
  | "inside-responsibility"
  | "no-responsibility";

export type PlacementColocationShape =
  | "with-behavior"
  | "without-behavior"
  | "with-types"
  | "without-types";

interface SymbolPlacement {
  aggregatorExposed: boolean;
  basename: string;
  colocation: PlacementColocationShape;
  directory: PlacementDirectoryShape;
  module: PlacementModuleShape;
}

export interface ArchitecturalRoleFinding {
  conceptSeed: boolean;
  consumers: {
    modules: number;
    responsibilities: string[];
    unresolvedModules: number;
    pathRegions: number;
  };
  declaration: {
    module: string;
    directory: string;
    pathRegion: string;
    responsibility?: string;
    placed: boolean;
    status: ResponsibilityModuleStatus;
  };
  evidence: { roles: RoleEvidence[]; scope: ScopeEvidence };
  exported: boolean;
  kind: SymbolKind;
  limitations: PrimitiveLimitation[];
  locality?: {
    distribution: SymbolDistributionShape;
    placement: DeclarationPlacement;
    usage: SymbolUsage;
  };
  name: string;
  placement: SymbolPlacement;
  primaryRole: ArchitecturalRole;
  relations: {
    implementers?: { colocated: number; elsewhere: number };
    derivedTypes?: { colocated: number; elsewhere: number };
  };
  responsibilityContext?: ResponsibilitySymbolLocality;
  roles: ArchitecturalRole[];
  scope: ArchitecturalScopeClass;
  served?: { responsibility: string; declarationAgrees: boolean };
  symbolId: string;
}

export type PrimitiveModuleShape =
  | "primitive-hub"
  | "contract-hub"
  | "configuration-hub"
  | "implementation-module"
  | "aggregator";

export type ColocationPattern =
  | "contract+implementation"
  | "schema+type"
  | "type+behavior"
  | "constant+behavior";

export interface PrimitiveModuleFinding {
  ambiguity?: ResponsibilityAmbiguityReason;
  basename: string;
  colocations: ColocationPattern[];
  composition: {
    roles: "single-role" | "mixed-role" | "none";
    scopes: "single-scope" | "mixed-scope" | "none";
    dominantRole?: { role: ArchitecturalRole; share: number };
    scopeGroups: number;
  };
  directory: string;
  exportedSymbols: number;
  fragmentation: {
    localGroups: number;
    crossResponsibility: number;
    packageWide: number;
    unplaced: number;
    unclear: number;
  };
  module: string;
  pathRegion: string;
  responsibilities: { id: string; symbols: number }[];
  responsibility?: string;
  roleBasename: boolean;
  roles: Partial<Record<ArchitecturalRole, number>>;
  scopes: Partial<Record<ArchitecturalScopeClass, number>>;
  shapes: PrimitiveModuleShape[];
  status: ResponsibilityModuleStatus;
  symbols: number;
  unresolvedSymbols: number;
}

export type ConventionDimension = "module" | "directory" | "colocation";

export type ConventionStatus =
  | "convention"
  | "competing"
  | "insufficient-evidence";

export interface PlacementConvention {
  dimension: ConventionDimension;
  exceptions: { symbols: number; symbolIds: string[] };
  id: string;
  provenance: {
    basenames: { basename: string; symbols: number }[];
  };
  role: ArchitecturalRole;
  scope: ArchitecturalScopeClass | "any";
  support: {
    symbols: number;
    modules: number;
    responsibilities: number;
    symbolIds: string[];
    moduleIds: string[];
    responsibilityIds: string[];
  };
  value: string;
}

export interface ConventionGroup {
  dimensions: Record<
    ConventionDimension,
    {
      status: ConventionStatus;
      conventions: string[];
      values: { value: string; symbols: number }[];
    }
  >;
  role: ArchitecturalRole;
  scope: ArchitecturalScopeClass | "any";
  symbols: number;
}

export type PrimitiveAmbiguityReason =
  | "no-role-evidence"
  | "naming-disagrees"
  | "no-placed-consumers"
  | "no-internal-consumers";

export interface PrimitiveAmbiguity {
  detail: string;
  reason: PrimitiveAmbiguityReason;
  symbolId: string;
}

export interface PrimitiveConventionSummary {
  byAmbiguity: Record<PrimitiveAmbiguityReason, number>;
  byColocation: Record<ColocationPattern, number>;
  byModuleComposition: {
    roles: Record<"single-role" | "mixed-role" | "none", number>;
    scopes: Record<"single-scope" | "mixed-scope" | "none", number>;
  };
  byModuleShape: Record<PrimitiveModuleShape, number>;
  byRole: Record<ArchitecturalRole, number>;
  byScope: Record<ArchitecturalScopeClass, number>;
  conventions: {
    roleAndScope: Record<ConventionStatus, number> & { observed: number };
    roleAlone: Record<ConventionStatus, number> & { observed: number };
  };
  exportedSymbols: number;
  limitations: Record<PrimitiveLimitation, number>;
  matrix: Record<ArchitecturalRole, Record<ArchitecturalScopeClass, number>>;
  misleadingRoleBasenames: number;
  modules: number;
  multiRoleSymbols: number;
  symbols: number;
  unresolvedModules: {
    total: number;
    explained: number;
    byShape: Record<PrimitiveModuleShape, number>;
    mixedScope: number;
    unexplained: number;
  };
}

interface PrimitiveConventionPolicy {
  conventions: { minimumSupport: number };
  dedicatedRoleShare: number;
  hub: { minimumSymbols: number; minimumResponsibilities: number };
  moduleShapeUniverse: "exported symbols; private declarations count in totals only";
  naming: "supporting evidence only; a disagreement with structural evidence is recorded, never applied";
  packageWide: {
    minimumResponsibilities: number;
    responsibilityShare: number;
    threshold: number;
  };
  roleBasenames: string[];
  roleDefinitions: Record<ArchitecturalRole, string>;
  rolePrecedence: ArchitecturalRole[];
  roles: ArchitecturalRole[];
  schemaLibraries: string[];
  scopeDefinitions: Record<ArchitecturalScopeClass, string>;
  scopes: ArchitecturalScopeClass[];
  symbolUniverse: "top-level declarations of primary modules";
  technicalRoots: string[];
  utility: { maximumStatements: number; minimumConsumers: number };
}

export interface PrimitiveConventionReport {
  conventionGroups: ConventionGroup[];
  conventions: PlacementConvention[];
  limitations: string[];
  modules: PrimitiveModuleFinding[];
  package: { id: string; root: string };
  policy: PrimitiveConventionPolicy;
  schemaVersion: typeof PRIMITIVE_CONVENTION_SCHEMA_VERSION;
  summary: PrimitiveConventionSummary;
  symbols: ArchitecturalRoleFinding[];
  unresolved: PrimitiveAmbiguity[];
}
