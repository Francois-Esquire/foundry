import type { InternalDistribution } from "./internal-topology-types";
import type { SymbolKind } from "./types";

// V13.1 symbol locality: where each internally consumed symbol is declared
// and where its consumers sit, derived from one `PackageLocalReport` and its
// `InternalPackageTopology`. Every field is an observation about the package
// as it is — no score, no move target, no recommendation. Versioned apart
// from the topology because the two evolve at different rates.

export const SYMBOL_LOCALITY_SCHEMA_VERSION = 1;

export type ArchitecturalScopeKind =
  | "module"
  | "directory"
  | "region"
  | "package";

/**
 * One node of the package-relative scope hierarchy. Modules sit in
 * directories, directories nest up to the package root, and path regions
 * partition the modules beside that tree; both roll up to the package.
 */
export interface ArchitecturalScope {
  /** `module:<path>`, `directory:<path>`, `region:<id>`, or `package:<id>`. */
  id: string;
  kind: ArchitecturalScopeKind;
  /** Primary modules inside the scope, sorted. */
  modules: string[];
  parent?: string;
  /** Package-relative module or directory path, region id, or package id. */
  path: string;
}

export interface ArchitecturalScopeRef {
  id: string;
  kind: ArchitecturalScopeKind;
  path: string;
}

/** The share one module, directory, or region holds of a symbol's consumers. */
export interface LocalityShare {
  bindingOccurrences: number;
  bindingShare: number;
  id: string;
  importSiteShare: number;
  importSites: number;
  /** Distinct consumer modules inside it. */
  modules: number;
  /** `modules` over the symbol's consumer modules. */
  share: number;
}

/**
 * Where the consumers sit, as a shape of their spread. `module-localized`
 * is one consumer module; `directory-localized` one consumer directory;
 * `region-localized` several directories in one path region; `multi-region`
 * several regions with one dominant or a two-way split;
 * `package-distributed` several regions with neither.
 */
export type SymbolDistributionShape =
  | "module-localized"
  | "directory-localized"
  | "region-localized"
  | "multi-region"
  | "package-distributed";

/**
 * How the declaration sits relative to observed consumption. Descriptive:
 * `broader-than-consumers` says the declaring directory is an ancestor of
 * the consumers' common directory; `narrower-than-consumers` that it is a
 * descendant while at least two regions consume significantly; `cross-region`
 * that the dominant consumer region is not the declaring one;
 * `cross-directory` a sibling directory inside the same region; `split`
 * exactly two significant regions, none dominant, together reaching the
 * dominant threshold; `distributed` a package-distributed spread; `unclear`
 * too few consumers to say.
 */
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

/** What the declaration is, from local facts: measured functions, a type-level contract, or a value. */
export type DeclarationShape = "behavior" | "contract" | "value";

export type SymbolLocalityLimitation =
  /** One consumer module: no distribution to describe. */
  | "single-consumer"
  /** Some consumer evidence is a syntactic `ns.member` access rather than a named import. */
  | "namespace-member-derived"
  /** A consumer imports the declaring (or forwarding) module as a bare namespace; its members are unknown here. */
  | "namespace-bare-use";

export type SymbolLocalityEvidence = "complete" | "partial" | "limited";

export interface RegionShare extends LocalityShare {
  /** At or above the significant-share threshold. */
  significant: boolean;
}

export interface SymbolLocalityFinding {
  behavior: {
    declarationShape: DeclarationShape;
    /** Measured functions the declaration owns. */
    declarationFunctions: number;
    /** Executable statements measured across consumer modules. */
    consumerStatements: number;
    /** Region holding the largest share of consumer statements; absent when none were measured. */
    dominantBehaviorRegion?: { id: string; share: number };
    /** Whether the behavior-heaviest consumer region is the module-heaviest one; absent without behavior. */
    agreesWithUsage?: boolean;
  };
  /** Deepest directory holding every consumer. */
  commonDirectory: { path: string; depth: number };
  /** Narrowest scope containing every consumer: the module, the common directory, the region when that directory is the root or a technical root, or the package across regions. */
  commonScope: ArchitecturalScopeRef;
  /** The declaration is a local concept seed (interface, class, type, enum, namespace). */
  conceptSeed: boolean;
  /** Sorted consumer module ids; per-module counts live on the topology's consumed surface. */
  consumerModules: string[];
  consumers: {
    modules: number;
    directories: number;
    regions: number;
    importSites: number;
    namespaceSites: number;
    bindingOccurrences: number;
    /** Consumer modules reaching the symbol through a re-export chain. */
    mediated: number;
    /** Consumer modules whose every site is type-only. */
    typeOnly: number;
  };
  declaration: {
    module: string;
    directory: string;
    region: string;
    /** Directory depth below the package root. */
    depth: number;
    scope: ArchitecturalScopeRef;
  };
  /** The declaring directory against `commonDirectory`; the root and a technical root count as the same level. */
  directoryRelationship: DirectoryRelationship;
  distribution: SymbolDistributionShape;
  /** Consumer directory with the most consumer modules (then import sites, then id). */
  dominantDirectory: LocalityShare;
  /** Consumer module with the most binding occurrences (import sites, then id, break ties). */
  dominantModule: LocalityShare;
  dominantRegion?: RegionShare;
  evidence: SymbolLocalityEvidence;
  /** Exported from its module. */
  exported: boolean;
  kind: SymbolKind;
  limitations: SymbolLocalityLimitation[];
  name: string;
  /** Reachable through a declared package entrypoint. Context only; external usage never enters locality. */
  packagePublic: boolean;
  placement: DeclarationPlacement;
  /** Every consumer region, by modules descending then id. */
  regions: RegionShare[];
  seams: {
    /** `consumerRegion→declarationRegion` for every consumer outside the declaring region, sorted. */
    crossed: string[];
    crossRegionConsumers: number;
    crossRegionShare: number;
  };
  significantRegions: number;
  structure: {
    /** Weakly connected groups of the primary graph induced on the consumer modules alone. */
    consumerComponents: number;
    /** Min and max layer among consumers. */
    layerSpan: { min: number; max: number };
    /** The cycle holding the most consumers, when any consumer is a cycle member. */
    cycle?: { id: string; consumerShare: number; declarationMember: boolean };
    bridgeConsumerShare: number;
    aggregatorConsumerShare: number;
  };
  symbolId: string;
  /** Top consumer region by modules; `dominant` when its share reaches the threshold. */
  topRegion: RegionShare;
  /** Type-only, value, or both, across consumer sites. */
  usage: SymbolUsage;
}

export interface SymbolLocalitySummary {
  /** Modules whose `default` is anonymous or an expression. */
  anonymousDefaultExports: number;
  /** Namespace import sites on primary edges with no member access recorded. */
  bareNamespaceSites: number;
  /** Findings whose behavior-heaviest and module-heaviest regions differ. */
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
    /** Share of the top consumer region, in percent. */
    topRegionShare: InternalDistribution;
  };
  limitations: Record<SymbolLocalityLimitation, number>;
  packagePublic: number;
  /** Internally consumed symbols with a finding. */
  symbols: number;
  /** Default import sites on primary edges that resolved to no declaration. */
  unresolvedDefaultImportSites: number;
}

/** The definitions the findings were computed under. */
interface SymbolLocalityPolicy {
  commonScope: "deepest common consumer directory; the region when that directory is the root or a technical root; the package across regions";
  dominanceDenominator: "consumer modules";
  dominantShareThreshold: number;
  minimumConsumers: number;
  significantShareThreshold: number;
  technicalRoots: string[];
}

export interface SymbolLocalityReport {
  /** Evidence the local report does not carry, so no finding can claim it. */
  limitations: string[];
  package: { id: string; root: string };
  policy: SymbolLocalityPolicy;
  schemaVersion: typeof SYMBOL_LOCALITY_SCHEMA_VERSION;
  scopes: ArchitecturalScope[];
  summary: SymbolLocalitySummary;
  /** By consumer modules descending, then symbol id. */
  symbols: SymbolLocalityFinding[];
}
