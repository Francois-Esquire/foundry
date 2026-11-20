import type {
  ConceptRelationshipKind,
  ConceptSeedKind,
  FileKind,
  LocalComplexityReport,
  ModuleRole,
  SymbolKind,
} from "./types";

export const PACKAGE_LOCAL_REPORT_SCHEMA_VERSION = 6;

interface PackageLocalIdentity {
  boundaryType: "package" | "directory";
  entrypoints: { entrypoint: string; file: string }[];
  explicitlyPublishable: boolean;
  exportSubpaths: string[] | null;
  name?: string;
  path: string;
}

interface PackageLocalSourceFile {
  kind: FileKind;
  path: string;
}

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

export interface PackageLocalImport {
  bindingOccurrences?: number;
  importedName?: string;
  kind: PackageLocalImportKind;
  localName?: string;
  members?: PackageLocalNamespaceMember[];
  scope: "internal" | "external";
  sourceModule: string;
  specifier: string;
  targetModule?: string;
  typeOnly: boolean;
  uses?: PackageLocalBindingUses;
}

interface PackageLocalNamespaceMember {
  name: string;
  occurrences: number;
}

export interface PackageLocalBindingUses {
  argument: number;
  called: number;
  collected: number;
  constructed: number;
  rendered: number;
}

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

export interface PackageLocalConceptParticipation {
  conceptId: string;
  module: string;
  relationships: Partial<Record<ConceptRelationshipKind, number>>;
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

export type PackageLocalAliasShape =
  | "scalar"
  | "brand"
  | "literal-union"
  | "object"
  | "reference"
  | "other";

export interface PackageLocalDeclaration {
  abstract?: boolean;
  aliasShape?: PackageLocalAliasShape;
  annotation?: string;
  asConst?: boolean;
  callee?: { name: string; specifier?: string; symbolId?: string };
  concepts: {
    conceptId: string;
    relationships: Partial<Record<ConceptRelationshipKind, number>>;
  }[];
  initializer?: PackageLocalInitializer;
  jsx?: boolean;
  members?: { methods: number; properties: number };
  symbolId: string;
  typeQueries?: string[];
}

export interface PackageLocalReport {
  anchor?: { target: string; reason?: string };
  conceptParticipation: PackageLocalConceptParticipation[];
  conceptSeeds: PackageLocalConceptSeed[];
  declarations: PackageLocalDeclaration[];
  defaultExports: PackageLocalDefaultExport[];
  imports: PackageLocalImport[];
  localComplexity: LocalComplexityReport;
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
