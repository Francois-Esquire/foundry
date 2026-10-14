import { relative, resolve } from "node:path";
import type { ExportDeclaration, Node, Project, SourceFile } from "ts-morph";

import type { Boundary } from "./boundary";
import { boundaryContains, boundaryEntrypoints, toPosix } from "./boundary";
import { classifyFile } from "./file-kind";
import type {
  InternalizeSymbolPlan,
  PlanBlocker,
  PlannedChange,
  PublicExposureRoute,
  ReductionOpportunity,
  StructuralDelta,
  SurfaceReport,
  SurfaceSymbol,
} from "./types";
import { planFingerprint } from "./validate";

const normalizeStatementPattern = /\s+/g;

// Read-only planning: a plan describes what would have to change for a
// symbol to leave the package-public API and what structural effect that
// change should have. Nothing here mutates source files.

const MAX_CHAIN_DEPTH = 16;

/**
 * How a package's own module binds a name from one of its entrypoints:
 * a named import (`import { X }`, `import type { X }`, `import { X as Y }`),
 * a default import, or a named re-export (`export { X } from`).
 */
type InternalImporterForm = "import" | "default" | "reexport";

/** One module of the package that binds a name from its entrypoint. */
interface InternalImporter {
  /** Root-relative importing file. */
  file: string;
  form: InternalImporterForm;
  /** The importer is a test file (`classifyFile`). */
  test: boolean;
}

export interface EntrypointContext {
  entrypoint: string;
  /** Declaration node → names it is exposed under from this entrypoint. */
  exposedNames: Map<Node, string[]>;
  file: SourceFile;
  fileRel: string;
  /**
   * Exposed name → the package's other modules that bind it from this
   * entrypoint, a default import under `default`. Re-exports from other
   * entrypoints are routes, not importers. Not seen: `import X =
   * require(...)` and dynamic `import()`.
   */
  internalImporters: Map<string, InternalImporter[]>;
  /** Names other boundary modules import from this entrypoint. */
  internallyImportedNames: Set<string>;
  /** A boundary module namespace-imports this entrypoint. */
  namespaceImported: boolean;
  /** Root-relative modules of the package that `export *` or `export * as` this entrypoint, sorted. */
  starReexporters: string[];
}

export interface ResolvedRoute {
  context: EntrypointContext;
  /** The entrypoint export statement, when the route goes through one. */
  declaration?: ExportDeclaration;
  /** Route is the declaration itself sitting in the entrypoint file. */
  direct: boolean;
  route: PublicExposureRoute;
}

function relPath(root: string, file: SourceFile): string {
  return toPosix(relative(root, file.getFilePath()));
}

function normalizeStatement(declaration: ExportDeclaration): string {
  return declaration.getText().replace(normalizeStatementPattern, " ").trim();
}

export function buildEntrypointContexts(
  project: Project,
  boundary: Boundary
): { contexts: EntrypointContext[]; unresolved: string[] } {
  const contexts: EntrypointContext[] = [];
  const unresolved: string[] = [];
  const boundaryFiles = project
    .getSourceFiles()
    .filter(
      (file) =>
        boundaryContains(boundary, file.getFilePath()) &&
        !file.isDeclarationFile()
    );

  const entries = boundaryEntrypoints(boundary).map((entry) => ({
    entry,
    file: project.getSourceFile(resolve(boundary.root, entry.file)),
  }));
  const entrypointFiles = new Set(
    entries.flatMap(({ file }) => (file === undefined ? [] : [file]))
  );
  for (const { entry, file } of entries) {
    if (file === undefined) {
      unresolved.push(entry.file);
      continue;
    }
    const exposedNames = new Map<Node, string[]>();
    for (const [name, declarations] of file.getExportedDeclarations()) {
      for (const declaration of declarations) {
        const names = exposedNames.get(declaration) ?? [];
        names.push(name);
        exposedNames.set(declaration, names);
      }
    }
    contexts.push({
      entrypoint: entry.entrypoint,
      exposedNames,
      file,
      fileRel: entry.file,
      ...internalUseOf(boundary.root, boundaryFiles, entrypointFiles, file),
    });
  }
  return { contexts, unresolved };
}

const exportedNodesCache = new WeakMap<SourceFile, Set<Node>>();

type InternalUse = Pick<
  EntrypointContext,
  | "internalImporters"
  | "internallyImportedNames"
  | "namespaceImported"
  | "starReexporters"
>;

/** How the package's other modules import and re-export the entrypoint `file`. */
function internalUseOf(
  root: string,
  boundaryFiles: SourceFile[],
  entrypointFiles: Set<SourceFile>,
  file: SourceFile
): InternalUse {
  const use: InternalUse = {
    internalImporters: new Map(),
    internallyImportedNames: new Set(),
    namespaceImported: false,
    starReexporters: [],
  };
  for (const other of boundaryFiles) {
    if (other === file) {
      continue;
    }
    const rel = relPath(root, other);
    const importer = (form: InternalImporterForm): InternalImporter => ({
      file: rel,
      form,
      test: classifyFile(rel) === "test",
    });
    for (const declaration of other.getImportDeclarations()) {
      if (declaration.getModuleSpecifierSourceFile() !== file) {
        continue;
      }
      if (declaration.getNamespaceImport() !== undefined) {
        use.namespaceImported = true;
      }
      if (declaration.getDefaultImport() !== undefined) {
        addImporter(use, "default", importer("default"));
      }
      for (const named of declaration.getNamedImports()) {
        use.internallyImportedNames.add(named.getName());
        addImporter(use, named.getName(), importer("import"));
      }
    }
    if (!entrypointFiles.has(other)) {
      internalReexportsOf(other, file, use, rel, importer);
    }
  }
  use.starReexporters.sort((a, b) => a.localeCompare(b));
  return use;
}

/** Re-exports of `file` in `other`, a module that is not an entrypoint. */
function internalReexportsOf(
  other: SourceFile,
  file: SourceFile,
  use: InternalUse,
  rel: string,
  importer: (form: InternalImporterForm) => InternalImporter
): void {
  for (const declaration of other.getExportDeclarations()) {
    if (
      declaration.getModuleSpecifier() === undefined ||
      declaration.getModuleSpecifierSourceFile() !== file
    ) {
      continue;
    }
    const named = declaration.getNamedExports();
    if (named.length === 0) {
      if (!use.starReexporters.includes(rel)) {
        use.starReexporters.push(rel);
      }
      continue;
    }
    for (const specifier of named) {
      addImporter(use, specifier.getName(), importer("reexport"));
    }
  }
}

function addImporter(
  use: InternalUse,
  name: string,
  importer: InternalImporter
): void {
  const list = use.internalImporters.get(name) ?? [];
  list.push(importer);
  use.internalImporters.set(name, list);
}

function exportsNode(file: SourceFile, node: Node): boolean {
  let nodes = exportedNodesCache.get(file);
  if (nodes === undefined) {
    nodes = new Set<Node>();
    for (const declarations of file.getExportedDeclarations().values()) {
      for (const declaration of declarations) {
        nodes.add(declaration);
      }
    }
    exportedNodesCache.set(file, nodes);
  }
  return nodes.has(node);
}

/**
 * Files from the entrypoint statement to the declaration, following simple
 * named re-export chains (and star hops). Falls back to
 * [entrypoint, declaration file] when the chain cannot be walked precisely.
 */
function chainFor(
  root: string,
  context: EntrypointContext,
  declaration: ExportDeclaration,
  localName: string,
  symbol: Pick<SurfaceSymbol, "declarationFile" | "name">,
  node: Node
): string[] {
  const chain = [context.fileRel];
  let current = declaration.getModuleSpecifierSourceFile();
  let name = localName;
  for (
    let depth = 0;
    depth < MAX_CHAIN_DEPTH && current !== undefined;
    depth += 1
  ) {
    const rel = relPath(root, current);
    if (chain.includes(rel)) {
      break;
    }
    chain.push(rel);
    if (rel === symbol.declarationFile) {
      return chain;
    }
    let next: SourceFile | undefined;
    for (const exported of current.getExportDeclarations()) {
      const specifier = exported
        .getNamedExports()
        .find(
          (spec) => (spec.getAliasNode()?.getText() ?? spec.getName()) === name
        );
      if (
        specifier !== undefined &&
        exported.getModuleSpecifier() !== undefined
      ) {
        name = specifier.getName();
        next = exported.getModuleSpecifierSourceFile();
        break;
      }
    }
    if (next === undefined) {
      const visitExported = (
        currentCurrent: SourceFile,
        initialNext: SourceFile | undefined
      ) => {
        let currentNext = initialNext;
        for (const exported of currentCurrent.getExportDeclarations()) {
          if (exported.getNamedExports().length > 0) {
            continue;
          }
          const target = exported.getModuleSpecifierSourceFile();
          if (target !== undefined && exportsNode(target, node)) {
            currentNext = target;
            break;
          }
        }
        return currentNext;
      };
      next = visitExported(current, next);
    }
    if (next === undefined) {
      break;
    }
    current = next;
  }
  return chain.at(-1) === symbol.declarationFile
    ? chain
    : [context.fileRel, symbol.declarationFile];
}

export function resolveRoute(
  root: string,
  context: EntrypointContext,
  rootEntrypoint: boolean,
  symbol: Pick<SurfaceSymbol, "declarationFile" | "name">,
  node: Node,
  exportedName: string
): ResolvedRoute {
  const base = {
    entrypoint: context.entrypoint,
    exportedName,
    file: context.fileRel,
  };

  for (const declaration of context.file.getExportDeclarations()) {
    const specifier = declaration
      .getNamedExports()
      .find(
        (spec) =>
          (spec.getAliasNode()?.getText() ?? spec.getName()) === exportedName
      );
    if (specifier === undefined) {
      continue;
    }
    const typeOnly = declaration.isTypeOnly() || specifier.isTypeOnly();
    let kind: "type-export" | "named-export" | "named-reexport";
    if (typeOnly) {
      kind = "type-export";
    } else if (declaration.getModuleSpecifier() === undefined) {
      kind = "named-export";
    } else {
      kind = "named-reexport";
    }
    return {
      context,
      declaration,
      direct: false,
      route: {
        ...base,
        chain: chainFor(
          root,
          context,
          declaration,
          specifier.getName(),
          symbol,
          node
        ),
        kind,
        line: specifier.getStartLineNumber(),
        statement: normalizeStatement(declaration),
      },
    };
  }

  if (
    symbol.declarationFile === context.fileRel &&
    exportedName === symbol.name
  ) {
    return {
      context,
      direct: true,
      route: {
        ...base,
        chain: [context.fileRel],
        kind: rootEntrypoint ? "named-export" : "subpath-export",
        line: node.getStartLineNumber(),
      },
    };
  }

  for (const declaration of context.file.getExportDeclarations()) {
    if (declaration.getNamedExports().length > 0) {
      continue;
    }
    const target = declaration.getModuleSpecifierSourceFile();
    if (target === undefined || !exportsNode(target, node)) {
      continue;
    }
    return {
      context,
      declaration,
      direct: false,
      route: {
        ...base,
        chain: [context.fileRel, relPath(root, target)],
        kind: "star-export",
        line: declaration.getStartLineNumber(),
        statement: normalizeStatement(declaration),
      },
    };
  }

  return {
    context,
    direct: false,
    route: { ...base, chain: [context.fileRel], kind: "other" },
  };
}

const ZERO_DELTA: StructuralDelta = {
  exportedSymbols: 0,
  externallyUsedSymbols: 0,
  totalSymbols: 0,
  unusedExternalExports: 0,
};

function planForSymbol(
  boundary: Boundary,
  opportunity: ReductionOpportunity,
  symbol: SurfaceSymbol,
  resolved: ResolvedRoute[],
  packageBlockers: PlanBlocker[],
  fullyEnumerable: boolean,
  declarationExportsName: boolean
): InternalizeSymbolPlan {
  const blockers: PlanBlocker[] = [...packageBlockers];
  const plannedChanges: PlannedChange[] = [];
  let unsupported = !fullyEnumerable;
  let hasDirect = false;
  const visitEntries = () => {
    ({ unsupported, hasDirect } = planForSymbolEntries(
      resolved,
      unsupported,
      blockers,
      symbol,
      plannedChanges,
      hasDirect,
      declarationExportsName
    ));
  };

  visitEntries();

  if (fullyEnumerable && resolved.length === 0) {
    unsupported = true;
    blockers.push({
      detail: `${symbol.name} is module-exported but no route through the declared package entrypoints exposes it; it may already be package-internal.`,
      reason: "no-public-route",
    });
  }

  if (boundary.explicitlyPublishable) {
    blockers.push({
      detail:
        'Package appears independently publishable ("private": false); consumers outside this repository are invisible to the analyzer.',
      reason: "publishable",
    });
  }
  let status: "unsupported" | "blocked" | "ready";
  if (unsupported) {
    status = "unsupported";
  } else if (boundary.explicitlyPublishable) {
    status = "blocked";
  } else {
    status = "ready";
  }

  const repointed = [
    ...new Set(
      plannedChanges
        .filter((change) => change.kind === "rewrite-import")
        .map((change) => change.file)
    ),
  ].sort((a, b) => a.localeCompare(b));
  let preservedBehavior: string[];
  if (status === "unsupported") {
    preservedBehavior = [];
  } else {
    preservedBehavior = [
      `Declaration remains in ${symbol.declarationFile}`,
      ...(repointed.length === 0
        ? ["Internal imports and references remain unchanged"]
        : [
            `${repointed.join(", ")} import ${symbol.name} from ${symbol.declarationFile} instead of the entrypoint`,
            "Other internal imports and references remain unchanged",
          ]),
      ...(hasDirect ? [] : ["Internal module exports remain unchanged"]),
      "Runtime behavior unchanged",
    ];
  }
  const predictedDelta: StructuralDelta =
    status === "unsupported"
      ? { ...ZERO_DELTA }
      : {
          exportedSymbols: -1,
          externallyUsedSymbols: 0,
          totalSymbols: 0,
          unusedExternalExports: -1,
        };

  const routes = resolved
    .map((entry) => entry.route)
    .sort(
      (a, b) =>
        a.entrypoint.localeCompare(b.entrypoint) ||
        a.file.localeCompare(b.file) ||
        (a.line ?? 0) - (b.line ?? 0)
    );
  plannedChanges.sort(
    (a, b) =>
      a.file.localeCompare(b.file) || a.description.localeCompare(b.description)
  );
  const uniqueBlockers = [
    ...new Map(
      blockers.map((blocker) => [
        `${blocker.reason}\n${blocker.detail}`,
        blocker,
      ])
    ).values(),
  ].sort(
    (a, b) =>
      a.reason.localeCompare(b.reason) || a.detail.localeCompare(b.detail)
  );

  const plan: Omit<InternalizeSymbolPlan, "fingerprint"> = {
    blockers: uniqueBlockers,
    evidence: opportunity.evidence,
    id: `plan:${opportunity.id}`,
    operation: "internalize-symbol",
    plannedChanges,
    predictedDelta,
    preservedBehavior,
    publicRoutes: routes,
    status,
    subject: opportunity.subject,
    target: {
      package: boundary.packageName ?? boundary.relPath,
      path: boundary.relPath,
    },
  };
  return { ...plan, fingerprint: planFingerprint(plan) };
}

function planForSymbolEntries(
  resolved: ResolvedRoute[],
  initialUnsupported: boolean,
  blockers: PlanBlocker[],
  symbol: SurfaceSymbol,
  plannedChanges: PlannedChange[],
  initialHasDirect: boolean,
  declarationExportsName: boolean
): { unsupported: boolean; hasDirect: boolean } {
  let hasDirect = initialHasDirect;
  let unsupported = initialUnsupported;
  // Importers can follow the symbol to its own file only while that file
  // keeps exporting it: not when the plan removes a direct declaration's.
  const declarationKeepsExport =
    declarationExportsName && !resolved.some((entry) => entry.direct);
  for (const entry of resolved) {
    const { route, declaration, direct } = entry;
    const refusal =
      routeFormRefusal(route, symbol) ??
      entrypointRefusal(entry, symbol) ??
      importerRefusal(entry, symbol, {
        declarationExportsName,
        declarationKeepsExport,
      });
    if (refusal !== undefined) {
      unsupported = true;
      blockers.push(...refusal.blockers);
      plannedChanges.push({
        description: refusal.change,
        file: route.file,
        kind: "unsupported",
      });
      continue;
    }
    if (direct) {
      hasDirect = true;
      plannedChanges.push({
        description: `Remove the export modifier from the declaration of ${symbol.name}.`,
        file: route.file,
        kind: "remove-public-export",
      });
      continue;
    }
    plannedChanges.push(...importRewrites(entry, symbol));
    const statement = route.statement ?? "";
    if (declaration !== undefined && declaration.getNamedExports().length > 1) {
      plannedChanges.push({
        description: `Remove ${route.exportedName} from: ${statement}`,
        file: route.file,
        kind: "rewrite-public-export",
      });
    } else {
      plannedChanges.push({
        description: `Remove the statement: ${statement}`,
        file: route.file,
        kind: "remove-public-export",
      });
    }
  }
  return { hasDirect, unsupported };
}

/** Why a route cannot be planned: its blockers and the unsupported change that stands for it. */
interface RouteRefusal {
  blockers: PlanBlocker[];
  change: string;
}

/** A route in an export form the planner cannot narrow. */
function routeFormRefusal(
  route: PublicExposureRoute,
  symbol: SurfaceSymbol
): RouteRefusal | undefined {
  if (route.kind === "star-export") {
    return {
      blockers: [
        {
          detail: `${symbol.name} is exposed through "${route.statement ?? "export *"}" in ${route.file}; selective internalization would require rewriting the star export.`,
          reason: "star-export",
        },
      ],
      change: `No precise change: ${symbol.name} is exposed through a star export.`,
    };
  }
  if (route.kind === "other") {
    return {
      blockers: [
        {
          detail: `The exposure of ${symbol.name} from ${route.file} does not match a recognized export form.`,
          reason: "unrecognized-route",
        },
      ],
      change: `No precise change: the exposure of ${symbol.name} is not a recognized export form.`,
    };
  }
  return undefined;
}

/**
 * Internal use of the whole entrypoint breaks for any route kind: a module
 * importing it as a namespace, or re-exporting all of it, relies on every
 * exposure the plan could remove.
 */
function entrypointRefusal(
  { route, context }: ResolvedRoute,
  symbol: SurfaceSymbol
): RouteRefusal | undefined {
  if (context.namespaceImported) {
    return {
      blockers: [
        {
          detail: `${route.file} is namespace-imported inside the package; internal use of ${symbol.name} cannot be ruled out.`,
          reason: "namespace-import",
        },
      ],
      change: `No precise change: ${route.file} is namespace-imported inside the package.`,
    };
  }
  if (context.starReexporters.length > 0) {
    const files = context.starReexporters.join(", ");
    return {
      blockers: [
        {
          detail: `${files} re-export${context.starReexporters.length === 1 ? "s" : ""} everything from the entrypoint ${route.file}; removing ${route.exportedName} would break their importers.`,
          reason: "internal-entrypoint-import",
        },
      ],
      change: `No precise change: ${route.file} is star re-exported inside the package.`,
    };
  }
  return undefined;
}

const ENTRYPOINT_IMPORT_CHANGE = (route: PublicExposureRoute) =>
  `No precise change: ${route.exportedName} is imported from the entrypoint inside the package.`;

/**
 * The package's own importers of the route's name, when they cannot be
 * repointed at the declaration's module. A direct declaration has nowhere
 * to repoint them; a re-export can, when every importer is a named import
 * outside the declaration file and the declaration file exports the symbol
 * under its own name. Tests alone keep their own reason.
 */
/** Whether the declaration's own file can take the importers. */
interface DeclarationExport {
  /** The declaration's file exports the symbol under its own name. */
  declarationExportsName: boolean;
  /** …and the plan leaves that export in place. */
  declarationKeepsExport: boolean;
}

function importerRefusal(
  { route, declaration, direct, context }: ResolvedRoute,
  symbol: SurfaceSymbol,
  declarationExport: DeclarationExport
): RouteRefusal | undefined {
  const name = route.exportedName;
  if (direct) {
    return context.internallyImportedNames.has(name)
      ? {
          blockers: [
            {
              detail: `${name} is imported from the entrypoint by other modules in the package; removing its public export would break them.`,
              reason: "internal-entrypoint-import",
            },
          ],
          change: ENTRYPOINT_IMPORT_CHANGE(route),
        }
      : undefined;
  }
  const importers = context.internalImporters.get(name) ?? [];
  if (importers.length === 0) {
    return undefined;
  }
  const obstacles = importerObstacles(
    route,
    declaration?.getModuleSpecifier() !== undefined,
    importers,
    symbol,
    declarationExport
  );
  if (obstacles.length > 0) {
    return {
      blockers: obstacles.map((detail) => ({
        detail,
        reason: "internal-entrypoint-import",
      })),
      change: ENTRYPOINT_IMPORT_CHANGE(route),
    };
  }
  const tests = filesOf(importers.filter((importer) => importer.test));
  if (tests.length > 0) {
    return {
      blockers: [
        {
          detail: `${name} is imported from the entrypoint ${route.file} by ${tests.length === 1 ? "the test" : "the tests"} ${tests.join(", ")}; repointing a test at ${symbol.declarationFile} would keep it passing while it no longer checks the entrypoint.`,
          reason: "internal-entrypoint-test-import",
        },
      ],
      change: ENTRYPOINT_IMPORT_CHANGE(route),
    };
  }
  return undefined;
}

function filesOf(importers: InternalImporter[]): string[] {
  return [...new Set(importers.map((importer) => importer.file))].sort((a, b) =>
    a.localeCompare(b)
  );
}

/** Every reason other than tests that the importers cannot follow the declaration. */
function importerObstacles(
  route: PublicExposureRoute,
  reexport: boolean,
  importers: InternalImporter[],
  symbol: SurfaceSymbol,
  { declarationExportsName, declarationKeepsExport }: DeclarationExport
): string[] {
  const name = route.exportedName;
  const obstacles: string[] = [];
  if (!reexport) {
    obstacles.push(
      `${name} is imported from the entrypoint by other modules in the package, and ${route.file} exports it without re-exporting it from another module; removing its public export would break them.`
    );
  }
  const defaults = filesOf(importers.filter((i) => i.form === "default"));
  if (defaults.length > 0) {
    obstacles.push(
      `${defaults.join(", ")} default-import${defaults.length === 1 ? "s" : ""} ${name} from the entrypoint ${route.file}; only named imports are repointed.`
    );
  }
  const reexporters = filesOf(importers.filter((i) => i.form === "reexport"));
  if (reexporters.length > 0) {
    obstacles.push(
      `${reexporters.join(", ")} re-export${reexporters.length === 1 ? "s" : ""} ${name} from the entrypoint ${route.file}; re-exports inside the package are not repointed.`
    );
  }
  if (importers.some((i) => i.file === symbol.declarationFile)) {
    obstacles.push(
      `${symbol.declarationFile} declares ${symbol.name} and imports ${name} from the entrypoint ${route.file}; it cannot import the symbol from itself.`
    );
  }
  if (!declarationExportsName) {
    obstacles.push(
      `${symbol.declarationFile} does not export ${symbol.name} under that name, so the importers of ${name} cannot import it from there.`
    );
  } else if (!declarationKeepsExport) {
    obstacles.push(
      `${symbol.declarationFile} is itself an entrypoint declaring ${symbol.name}, and the plan removes that export, so the importers of ${name} cannot import it from there.`
    );
  }
  return obstacles;
}

/** One `rewrite-import` per module importing the route's name from the entrypoint. */
function importRewrites(
  { route, context }: ResolvedRoute,
  symbol: SurfaceSymbol
): PlannedChange[] {
  const name = route.exportedName;
  const binding =
    name === symbol.name ? name : `${symbol.name} (exposed as ${name})`;
  return filesOf(context.internalImporters.get(name) ?? []).map((file) => ({
    description: `Import ${binding} from ${symbol.declarationFile} instead of the entrypoint ${route.file}.`,
    file,
    kind: "rewrite-import" as const,
  }));
}

/**
 * Build one read-only internalization plan per internalize-symbol
 * opportunity. Requires the live ts-morph project — routes are resolved from
 * the entrypoint ASTs — so this runs during analysis; the resulting plans are
 * plain serializable data.
 */
export function buildInternalizationPlans(
  project: Project,
  boundary: Boundary,
  symbols: SurfaceSymbol[],
  opportunities: ReductionOpportunity[],
  nodesById: Map<string, Node>
): InternalizeSymbolPlan[] {
  const internalize = opportunities.filter(
    (opportunity) => opportunity.operation === "internalize-symbol"
  );
  if (internalize.length === 0) {
    return [];
  }

  const symbolsById = new Map(symbols.map((symbol) => [symbol.id, symbol]));
  const { contexts, unresolved } = buildEntrypointContexts(project, boundary);

  const packageBlockers: PlanBlocker[] = [];
  const wildcard =
    boundary.exportSubpaths !== null &&
    [...boundary.exportSubpaths].some((subpath) => subpath.includes("*"));
  if (wildcard) {
    packageBlockers.push({
      detail:
        "Package declares wildcard exports subpaths; public routes cannot be fully enumerated.",
      reason: "wildcard-exports",
    });
  }
  for (const file of unresolved) {
    packageBlockers.push({
      detail: `Entrypoint ${file} could not be resolved to an analyzed source file.`,
      reason: "unresolved-entrypoint",
    });
  }
  const fullyEnumerable = packageBlockers.length === 0;

  return internalize.map((opportunity) => {
    const symbol = symbolsById.get(opportunity.subject.id);
    const node = nodesById.get(opportunity.subject.id);
    if (symbol === undefined || node === undefined) {
      throw new Error(
        `Internalize opportunity references unknown symbol ${opportunity.subject.id}`
      );
    }
    const resolved: ResolvedRoute[] = [];
    for (const context of contexts) {
      const rootEntrypoint = context.entrypoint === boundary.packageName;
      const names = context.exposedNames.get(node);
      if (names === undefined) {
        continue;
      }
      for (const name of [...names].sort((a, b) => a.localeCompare(b))) {
        resolved.push(
          resolveRoute(
            boundary.root,
            context,
            rootEntrypoint,
            symbol,
            node,
            name
          )
        );
      }
    }
    return planForSymbol(
      boundary,
      opportunity,
      symbol,
      resolved,
      packageBlockers,
      fullyEnumerable,
      exportsUnder(node, symbol.name)
    );
  });
}

const exportedByNameCache = new WeakMap<
  SourceFile,
  ReadonlyMap<string, Node[]>
>();

/** The declaration's own file exports `node` under `name`. */
function exportsUnder(node: Node, name: string): boolean {
  const file = node.getSourceFile();
  let exported = exportedByNameCache.get(file);
  if (exported === undefined) {
    exported = file.getExportedDeclarations();
    exportedByNameCache.set(file, exported);
  }
  return exported.get(name)?.includes(node) ?? false;
}

/**
 * Select the plan built for an internalize-symbol opportunity. Plans are
 * computed during analysis (route resolution needs the source ASTs); this is
 * the deterministic opportunity → plan lookup.
 */
export function buildInternalizationPlan(
  report: SurfaceReport,
  opportunity: ReductionOpportunity
): InternalizeSymbolPlan {
  if (opportunity.operation !== "internalize-symbol") {
    throw new Error(
      `buildInternalizationPlan only selects internalize-symbol plans (got ${opportunity.operation})`
    );
  }
  const plan = report.plans.find(
    (candidate): candidate is InternalizeSymbolPlan =>
      candidate.operation === "internalize-symbol" &&
      candidate.subject.id === opportunity.subject.id
  );
  if (plan === undefined) {
    throw new Error(`No plan found for opportunity ${opportunity.id}`);
  }
  return plan;
}
