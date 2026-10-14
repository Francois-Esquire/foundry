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

// V13.3 primitive and convention intelligence: what architectural role each
// internal symbol plays, which responsibility scope it serves, what a module
// is made of once its symbols are known, and which placement patterns the
// package already repeats. Symbol first, module second, convention last.
// Every classification keeps the evidence that produced it; `unknown` and
// `unclear` are results, not failures. Nothing here names a move.

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

/**
 * The responsibility scope a symbol serves, from V13.2 regions. `module-local`
 * is structural (not exported); `unplaced` means the declaring module is
 * unresolved and no consumer is placed either; `unclear` means too little
 * placed consumer evidence to say.
 */
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

/**
 * How much of the scope classification rests on measured consumers:
 * `complete` when every consumer is placed, `partial` when some are
 * unresolved, `structural` for module-local, `none` for unclear/unplaced.
 */
export type ScopeEvidence = "complete" | "partial" | "structural" | "none";

export type PrimitiveLimitation =
  /** Non-exported symbols: use inside the declaring module is not measured. */
  | "intra-module-usage-unmeasured"
  | "unresolved-consumers"
  | "no-internal-consumers"
  | "declaration-unplaced"
  | "namespace-derived";

export type PlacementModuleShape =
  | "dedicated-role-module"
  | "mixed-role-module";

/**
 * Where the declaring module sits relative to the responsibility the symbol
 * serves. `package-root`: the root or a technical root. `dedicated-role-directory`:
 * every module of the directory is dedicated to one role. `outside-responsibility`:
 * a responsibility-local symbol declared outside the responsibility it serves.
 * `responsibility-root`: the responsibility's shallowest directory.
 * `no-responsibility`: nothing to relate to.
 */
export type PlacementDirectoryShape =
  | "package-root"
  | "dedicated-role-directory"
  | "outside-responsibility"
  | "responsibility-root"
  | "inside-responsibility"
  | "no-responsibility";

/** Whether the module also exports the other family: behavior beside a primitive, types beside behavior. */
export type PlacementColocationShape =
  | "with-behavior"
  | "without-behavior"
  | "with-types"
  | "without-types";

interface SymbolPlacement {
  /** Some consumer reaches the symbol through a re-export chain (V13.1 mediated). */
  aggregatorExposed: boolean;
  /** Module basename without extension; observed, never a classifier. */
  basename: string;
  colocation: PlacementColocationShape;
  directory: PlacementDirectoryShape;
  module: PlacementModuleShape;
}

export interface ArchitecturalRoleFinding {
  conceptSeed: boolean;
  consumers: {
    modules: number;
    /** Distinct placed consumer responsibilities, sorted. */
    responsibilities: string[];
    unresolvedModules: number;
    pathRegions: number;
  };
  declaration: {
    module: string;
    directory: string;
    pathRegion: string;
    responsibility?: string;
    /** The declaring module is assigned or attached in V13.2. */
    placed: boolean;
    status: ResponsibilityModuleStatus;
  };
  evidence: { roles: RoleEvidence[]; scope: ScopeEvidence };
  exported: boolean;
  kind: SymbolKind;
  limitations: PrimitiveLimitation[];
  /** V13.1 facts for consumed symbols; supporting evidence only. */
  locality?: {
    distribution: SymbolDistributionShape;
    placement: DeclarationPlacement;
    usage: SymbolUsage;
  };
  name: string;
  placement: SymbolPlacement;
  primaryRole: ArchitecturalRole;
  relations: {
    /** Contracts: symbols implementing or extending this one, in the same module and elsewhere. */
    implementers?: { colocated: number; elsewhere: number };
    /** Schemas: type aliases derived from this one through `typeof`. */
    derivedTypes?: { colocated: number; elsewhere: number };
  };
  /** V13.2's own label for the symbol, untouched. */
  responsibilityContext?: ResponsibilitySymbolLocality;
  roles: ArchitecturalRole[];
  scope: ArchitecturalScopeClass;
  /** Responsibility-local symbols: the one responsibility served, and whether the declaration sits in it. */
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
  /** Shapes over exported, classified symbols; private helpers do not make a module mixed. */
  composition: {
    roles: "single-role" | "mixed-role" | "none";
    scopes: "single-scope" | "mixed-scope" | "none";
    dominantRole?: { role: ArchitecturalRole; share: number };
    /** Scope groups among exported symbols: one per served responsibility, plus cross-responsibility and package-wide. */
    scopeGroups: number;
  };
  directory: string;
  exportedSymbols: number;
  fragmentation: {
    /** Distinct responsibilities served by responsibility-local exported symbols. */
    localGroups: number;
    crossResponsibility: number;
    packageWide: number;
    unplaced: number;
    unclear: number;
  };
  module: string;
  pathRegion: string;
  /** Responsibilities the module's exported symbols serve, by symbols descending then id. */
  responsibilities: { id: string; symbols: number }[];
  responsibility?: string;
  /** Basename names a role (types, constants, config, …). */
  roleBasename: boolean;
  /** Over every declared symbol. */
  roles: Partial<Record<ArchitecturalRole, number>>;
  scopes: Partial<Record<ArchitecturalScopeClass, number>>;
  shapes: PrimitiveModuleShape[];
  status: ResponsibilityModuleStatus;
  symbols: number;
  /** Symbols whose scope is unplaced or unclear. */
  unresolvedSymbols: number;
}

export type ConventionDimension = "module" | "directory" | "colocation";

export type ConventionStatus =
  | "convention"
  | "competing"
  | "insufficient-evidence";

/** A placement value recurring among symbols of one role and scope; support and exceptions are raw counts. */
export interface PlacementConvention {
  dimension: ConventionDimension;
  /** Symbols of the same role and scope placed otherwise. */
  exceptions: { symbols: number; symbolIds: string[] };
  /** `<role>/<scope>/<dimension>=<value>`. */
  id: string;
  provenance: {
    /** Module basenames among the support, by symbols descending. */
    basenames: { basename: string; symbols: number }[];
  };
  role: ArchitecturalRole;
  /** `any` groups by role alone, for comparison with role-and-scope grouping. */
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
      /** Convention ids at or above minimum support, by symbols descending. */
      conventions: string[];
      /** Every value seen, by symbols descending then value. */
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
    /** Grouped by role and scope. */
    roleAndScope: Record<ConventionStatus, number> & { observed: number };
    /** Grouped by role alone. */
    roleAlone: Record<ConventionStatus, number> & { observed: number };
  };
  exportedSymbols: number;
  limitations: Record<PrimitiveLimitation, number>;
  /** Role × scope counts. */
  matrix: Record<ArchitecturalRole, Record<ArchitecturalScopeClass, number>>;
  /** Modules whose basename names a role and whose exported symbols span several scope groups. */
  misleadingRoleBasenames: number;
  modules: number;
  multiRoleSymbols: number;
  symbols: number;
  /** V13.2 unresolved modules that V13.3 describes with a shape or mixed composition. */
  unresolvedModules: {
    total: number;
    explained: number;
    byShape: Record<PrimitiveModuleShape, number>;
    mixedScope: number;
    unexplained: number;
  };
}

/** The definitions the findings were computed under. */
export interface PrimitiveConventionPolicy {
  conventions: { minimumSupport: number };
  /** A module is dedicated to its dominant role at or above this share of exported classified symbols. */
  dedicatedRoleShare: number;
  hub: { minimumSymbols: number; minimumResponsibilities: number };
  moduleShapeUniverse: "exported symbols; private declarations count in totals only";
  naming: "supporting evidence only; a disagreement with structural evidence is recorded, never applied";
  /** Responsibilities at which a symbol is package-wide: the larger of the floor and the share of placed regions. */
  packageWide: {
    minimumResponsibilities: number;
    responsibilityShare: number;
    threshold: number;
  };
  roleBasenames: string[];
  roleDefinitions: Record<ArchitecturalRole, string>;
  /** Primary role is the first of a symbol's roles in this order. */
  rolePrecedence: ArchitecturalRole[];
  roles: ArchitecturalRole[];
  /** Import specifiers whose call results are schemas. */
  schemaLibraries: string[];
  scopeDefinitions: Record<ArchitecturalScopeClass, string>;
  scopes: ArchitecturalScopeClass[];
  symbolUniverse: "top-level declarations of primary modules";
  technicalRoots: string[];
  utility: { maximumStatements: number; minimumConsumers: number };
}

export interface PrimitiveConventionReport {
  /** By role, then scope. */
  conventionGroups: ConventionGroup[];
  /** By support symbols descending, then id. */
  conventions: PlacementConvention[];
  /** Evidence not available here, so no finding can claim it. */
  limitations: string[];
  /** By module. */
  modules: PrimitiveModuleFinding[];
  package: { id: string; root: string };
  policy: PrimitiveConventionPolicy;
  schemaVersion: typeof PRIMITIVE_CONVENTION_SCHEMA_VERSION;
  summary: PrimitiveConventionSummary;
  /** By symbol id. */
  symbols: ArchitecturalRoleFinding[];
  /** By symbol id, then reason. */
  unresolved: PrimitiveAmbiguity[];
}
