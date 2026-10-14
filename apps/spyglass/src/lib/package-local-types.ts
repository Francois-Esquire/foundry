import type {
  ConceptRelationshipKind,
  ConceptSeedKind,
  FileKind,
  LocalComplexityReport,
  ModuleRole,
  SymbolKind,
} from "./types";

// V12.6 package-local report: what one package is, independent of the
// workspace around it. Versioned apart from `SurfaceReport` and the dataset
// schema because the cache stores this shape.

export const PACKAGE_LOCAL_REPORT_SCHEMA_VERSION = 6;

interface PackageLocalIdentity {
  boundaryType: "package" | "directory";
  /** Declared entrypoints resolved to owned TypeScript sources. */
  entrypoints: { entrypoint: string; file: string }[];
  explicitlyPublishable: boolean;
  /** Declared `exports` subpaths ("" = root); null when the manifest declares none. */
  exportSubpaths: string[] | null;
  name?: string;
  /** Repository-relative posix directory. */
  path: string;
}

interface PackageLocalSourceFile {
  kind: FileKind;
  /** Repository-relative posix path. */
  path: string;
}

/** The intrinsic half of a `SurfaceSymbol`; usage fields are workspace-derived. */
export interface PackageLocalSymbol {
  declarationFile: string;
  exported: boolean;
  id: string;
  kind: SymbolKind;
  name: string;
  packagePublic: boolean;
  startLine: number;
}

type PackageLocalImportKind =
  | "named"
  | "type"
  | "default"
  | "namespace"
  | "side-effect"
  | "re-export"
  | "star-re-export";

/**
 * One import or re-export site, recorded symbolically: the module specifier
 * and the names it asks for, never what they resolve to. `scope` says
 * whether the specifier resolved inside the package; an external site is an
 * address for workspace reference resolution to bind later.
 */
export interface PackageLocalImport {
  /**
   * Syntactic count of identifiers spelling `localName` in the source module
   * outside import and export declarations. Not checker-resolved: a shadowing
   * local binding of the same name counts too. Absent when the site binds no
   * local name (side-effect imports, re-exports).
   */
  bindingOccurrences?: number;
  importedName?: string;
  kind: PackageLocalImportKind;
  localName?: string;
  /**
   * Namespace sites only: member names accessed through the binding
   * (`ns.member`, in value or type position), with their syntactic
   * occurrence counts. A bare use of the binding is not a member access and
   * stays namespace-level. Absent when nothing is accessed through it.
   */
  members?: PackageLocalNamespaceMember[];
  scope: "internal" | "external";
  sourceModule: string;
  specifier: string;
  /** Repository-relative posix path the specifier resolved to; internal sites only. */
  targetModule?: string;
  typeOnly: boolean;
  /**
   * Named and default value bindings of internal sites only: how the
   * binding is used, by the same syntactic-by-name rule as
   * `bindingOccurrences`. Absent when no occurrence is one of these uses.
   */
  uses?: PackageLocalBindingUses;
}

interface PackageLocalNamespaceMember {
  name: string;
  occurrences: number;
}

/** Wiring uses of one import binding; a member chain rooted at the binding counts as the binding. */
export interface PackageLocalBindingUses {
  /** Call or `new` argument. */
  argument: number;
  /** Call callee. */
  called: number;
  /** Object-literal property value or shorthand, or array element. */
  collected: number;
  /** `new` target. */
  constructed: number;
  /** JSX tag. */
  rendered: number;
}

/**
 * One module's `default` export. `symbolId` names the owned top-level
 * declaration it resolves to (`export default Foo`, `export default function
 * Foo`, `export { Foo as default }`, forwarded defaults); absent for an
 * anonymous or expression default, which has no declaration identity here.
 */
export interface PackageLocalDefaultExport {
  module: string;
  symbolId?: string;
}

export interface PackageLocalConceptSeed {
  file: string;
  id: string;
  kind: ConceptSeedKind;
  name: string;
}

/**
 * One module's explicit TypeScript relationships to one local concept seed,
 * swept over the package's own sources alone (the V7 relationship kinds,
 * resolved against the package-local program). The seed's own declaration is
 * not a participation; other declarations in the declaring file are.
 */
export interface PackageLocalConceptParticipation {
  conceptId: string;
  /** Repository-relative posix path of the participating module. */
  module: string;
  /** Occurrences per relationship kind. */
  relationships: Partial<Record<ConceptRelationshipKind, number>>;
  /** Symbol ids of the module's top-level declarations holding those occurrences, sorted; module-level code adds none. */
  symbols: string[];
}

export type PackageLocalInitializer =
  | "function"
  | "class"
  | "object"
  | "array"
  | "literal"
  | "call"
  | "new"
  | "reference"
  | "other"
  | "none";

/**
 * The syntactic form of a type alias's right-hand side. `scalar` aliases one
 * primitive; `brand` intersects a primitive with an object type; `literal-union`
 * is a union of literals alone; `object` a type literal; `reference` another
 * named type (generic instantiations included).
 */
export type PackageLocalAliasShape =
  | "scalar"
  | "brand"
  | "literal-union"
  | "object"
  | "reference"
  | "other";

/**
 * One symbol's own declaration shape and its explicit relationships to local
 * concept seeds (the V7 relationship kinds, per symbol rather than per
 * module). Syntax alone: nothing here is resolved through the checker except
 * the local identities named by an annotation or a `typeof` query.
 */
export interface PackageLocalDeclaration {
  abstract?: boolean;
  /** Type aliases. */
  aliasShape?: PackageLocalAliasShape;
  /** Variables: the local symbol named by the type annotation's outermost reference. */
  annotation?: string;
  /** Variables: `as const` on the initializer. */
  asConst?: boolean;
  /** Variables initialized by a call: the leftmost identifier of the callee chain, and the import specifier that bound it, or the local symbol it names. */
  callee?: { name: string; specifier?: string; symbolId?: string };
  /** Relationships this declaration holds to local seeds, by concept id; keys sorted. */
  concepts: {
    conceptId: string;
    relationships: Partial<Record<ConceptRelationshipKind, number>>;
  }[];
  /** Variables: the form of the initializer. */
  initializer?: PackageLocalInitializer;
  /** Functions and function-valued variables: the body contains JSX. */
  jsx?: boolean;
  /** Interfaces, classes, and object-literal type aliases: callable members versus data members. */
  members?: { methods: number; properties: number };
  symbolId: string;
  /** Type aliases: local symbols named inside `typeof` queries, sorted. */
  typeQueries?: string[];
}

export interface PackageLocalReport {
  anchor?: { target: string; reason?: string };
  /** Sorted by concept id, then module. */
  conceptParticipation: PackageLocalConceptParticipation[];
  conceptSeeds: PackageLocalConceptSeed[];
  /** One per symbol, in symbol order. */
  declarations: PackageLocalDeclaration[];
  /** Sorted by module; one entry per module with a `default` export. */
  defaultExports: PackageLocalDefaultExport[];
  imports: PackageLocalImport[];
  /**
   * Resolved against the package alone: `parameters.boolean` counts an
   * annotation that names another package's type as non-boolean, and
   * workspace derivation re-measures that one metric on the shared program.
   */
  localComplexity: LocalComplexityReport;
  /** Keyed by repository-relative path, sorted. */
  moduleRoles: Record<string, ModuleRole>;
  package: PackageLocalIdentity;
  policyVersion: number;
  schemaVersion: typeof PACKAGE_LOCAL_REPORT_SCHEMA_VERSION;
  sources: PackageLocalSourceFile[];
  summary: {
    totalSymbols: number;
    moduleExportedSymbols: number;
    packagePublicSymbols: number;
    moduleOnlyExports: number;
    declaredSurfaceRatio: number;
  };
  symbols: PackageLocalSymbol[];
}
