import { posix } from "node:path";
import type {
  ExportDeclaration,
  Identifier,
  ImportDeclaration,
  ImportSpecifier,
  Symbol as MorphSymbol,
  Project,
  SourceFile,
} from "ts-morph";
import { Node, SyntaxKind } from "ts-morph";
import { classifyFile } from "./file-kind";
import type {
  PlannedClosureDependency,
  PlannedDependencyClass,
  PlannedImportKind,
  PlannedMovementClosure,
} from "./operator-plan-types";
import type {
  LocatedSymbol,
  OperatorPlanningContext,
  OperatorPlanningPackage,
} from "./operator-planning-context";
import {
  exportedNamesOf,
  packageOfFile,
  relativeFile,
} from "./operator-planning-context";
import type { EntrypointContext, ResolvedRoute } from "./plan";
import { buildEntrypointContexts, resolveRoute } from "./plan";
import { topLevelDeclarations } from "./symbols";
import type { ChurnFileKind, FileKind } from "./types";

const targetPattern = /\.tsx?$/;

// Source queries the planner asks of the shared project: who imports a
// declaration, what a declaration needs, how a package exposes it. Every
// function reads the AST and returns plain data; none manipulates it.

type ImportSiteForm = "import" | "reexport" | "star-reexport";

/** One import or re-export declaration that binds a symbol from another module. */
export interface ImportSite {
  /** Root-relative importing file. */
  file: string;
  fileKind: ChurnFileKind;
  form: ImportSiteForm;
  kind: PlannedImportKind;
  /** Exported names of the symbol bound here, sorted. */
  names: string[];
  /** Names the site imports beyond the symbol; a rewrite must leave them. */
  otherNames: string[];
  package?: string;
  /** Root-relative file the specifier resolves to. */
  resolvedFile: string;
  specifier: string;
  typeOnly: boolean;
  /** The specifier names a package, not a path. */
  viaPackage: boolean;
}

interface SpecifierIndex {
  /** Resolved absolute file → declarations whose specifier resolves to it. */
  byTarget: Map<
    string,
    { file: SourceFile; declaration: ImportDeclaration | ExportDeclaration }[]
  >;
}

const indexCache = new WeakMap<Project, SpecifierIndex>();

function specifierIndex(context: OperatorPlanningContext): SpecifierIndex {
  let index = indexCache.get(context.project);
  if (index !== undefined) {
    return index;
  }
  const byTarget = new Map<
    string,
    { file: SourceFile; declaration: ImportDeclaration | ExportDeclaration }[]
  >();
  const add = (
    file: SourceFile,
    declaration: ImportDeclaration | ExportDeclaration
  ) => {
    const target = declaration.getModuleSpecifierSourceFile();
    if (target === undefined) {
      return;
    }
    const list = byTarget.get(target.getFilePath()) ?? [];
    list.push({ declaration, file });
    byTarget.set(target.getFilePath(), list);
  };
  for (const file of context.project.getSourceFiles()) {
    if (file.isDeclarationFile() || file.isInNodeModules()) {
      continue;
    }
    for (const declaration of file.getImportDeclarations()) {
      add(file, declaration);
    }
    for (const declaration of file.getExportDeclarations()) {
      if (declaration.getModuleSpecifier() !== undefined) {
        add(file, declaration);
      }
    }
  }
  index = { byTarget };
  indexCache.set(context.project, index);
  return index;
}

function isPackageSpecifier(specifier: string): boolean {
  return !(specifier.startsWith(".") || specifier.startsWith("/"));
}

/** Names accessed as `ns.Name` on a namespace import, restricted to `names`. */
function namespaceUses(
  file: SourceFile,
  alias: string,
  names: string[]
): string[] {
  const used = new Set<string>();
  for (const access of file.getDescendantsOfKind(
    SyntaxKind.PropertyAccessExpression
  )) {
    if (access.getExpression().getText() !== alias) {
      continue;
    }
    const name = access.getName();
    if (names.includes(name)) {
      used.add(name);
    }
  }
  for (const qualified of file.getDescendantsOfKind(SyntaxKind.QualifiedName)) {
    if (qualified.getLeft().getText() !== alias) {
      continue;
    }
    const name = qualified.getRight().getText();
    if (names.includes(name)) {
      used.add(name);
    }
  }
  return [...used].sort((a, b) => a.localeCompare(b));
}

/**
 * Every import or re-export site in the project that binds `symbol` from a
 * module exporting it, directly or through re-export chains. Sites inside
 * the declaring file itself are not sites.
 */
export function importSitesOf(
  context: OperatorPlanningContext,
  symbol: LocatedSymbol
): ImportSite[] {
  const sites: ImportSite[] = [];
  for (const [target, entries] of specifierIndex(context).byTarget) {
    const targetFile = context.project.getSourceFile(target);
    if (targetFile === undefined) {
      continue;
    }
    const names = exportedNamesOf(targetFile, symbol.node);
    if (names.length === 0) {
      continue;
    }
    importSitesOfEntries(entries, symbol, context, targetFile, names, sites);
  }
  return sites.sort(
    (a, b) =>
      a.file.localeCompare(b.file) ||
      a.specifier.localeCompare(b.specifier) ||
      a.kind.localeCompare(b.kind)
  );
}

function importSitesOfEntries(
  entries: {
    file: SourceFile;
    declaration: ImportDeclaration | ExportDeclaration;
  }[],
  symbol: LocatedSymbol,
  context: OperatorPlanningContext,
  targetFile: SourceFile,
  names: string[],
  sites: ImportSite[]
) {
  for (const { file, declaration } of entries) {
    if (file === symbol.sourceFile) {
      continue;
    }
    const rel = relativeFile(context, file);
    const specifier = declaration.getModuleSpecifierValue() ?? "";
    const base = {
      file: rel,
      ...(packageOfFile(context, rel) !== undefined && {
        package: packageOfFile(context, rel),
      }),
      fileKind: classifyFile(rel),
      resolvedFile: relativeFile(context, targetFile),
      specifier,
      viaPackage: isPackageSpecifier(specifier),
    };
    if (Node.isImportDeclaration(declaration)) {
      importSitesOfEntriesEntries3(declaration, names, sites, base, file);
    } else {
      const named = declaration.getNamedExports();
      if (named.length === 0) {
        sites.push({
          ...base,
          form: "star-reexport",
          kind: "named",
          names,
          otherNames: [],
          typeOnly: declaration.isTypeOnly(),
        });
        continue;
      }
      const bound = named
        .filter((n) => names.includes(n.getName()))
        .map((n) => n.getName())
        .sort((a, b) => a.localeCompare(b));
      if (bound.length === 0) {
        continue;
      }
      const typeOnly =
        declaration.isTypeOnly() ||
        named
          .filter((n) => names.includes(n.getName()))
          .every((n) => n.isTypeOnly());
      sites.push({
        ...base,
        form: "reexport",
        kind: typeOnly ? "type" : "named",
        names: bound,
        otherNames: named
          .filter((n) => !names.includes(n.getName()))
          .map((n) => n.getName())
          .sort((a, b) => a.localeCompare(b)),
        typeOnly,
      });
    }
  }
}

function importSitesOfEntriesEntries3(
  declaration: ImportDeclaration,
  names: string[],
  sites: ImportSite[],
  base: {
    fileKind: FileKind;
    resolvedFile: string;
    specifier: string;
    viaPackage: boolean;
    package?: string | undefined;
    file: string;
  },
  file: SourceFile
) {
  const named = declaration.getNamedImports();
  const bound = named
    .filter((n) => names.includes(n.getName()))
    .map((n) => n.getName())
    .sort((a, b) => a.localeCompare(b));
  const others = named
    .filter((n) => !names.includes(n.getName()))
    .map((n) => n.getName())
    .sort((a, b) => a.localeCompare(b));
  importSitesOfEntriesEntries(
    bound,
    declaration,
    named,
    names,
    sites,
    base,
    others
  );
  if (
    declaration.getDefaultImport() !== undefined &&
    names.includes("default")
  ) {
    sites.push({
      ...base,
      form: "import",
      kind: "default",
      names: ["default"],
      otherNames: others,
      typeOnly: declaration.isTypeOnly(),
    });
  }
  const namespace = declaration.getNamespaceImport();
  importSitesOfEntriesEntries2(
    namespace,
    file,
    names,
    sites,
    base,
    declaration
  );
}

function importSitesOfEntriesEntries2(
  namespace: Identifier | undefined,
  file: SourceFile,
  names: string[],
  sites: ImportSite[],
  base: {
    fileKind: FileKind;
    resolvedFile: string;
    specifier: string;
    viaPackage: boolean;
    package?: string | undefined;
    file: string;
  },
  declaration: ImportDeclaration
) {
  if (namespace !== undefined) {
    const used = namespaceUses(file, namespace.getText(), names);
    if (used.length > 0) {
      sites.push({
        ...base,
        form: "import",
        kind: "namespace",
        names: used,
        otherNames: [],
        typeOnly: declaration.isTypeOnly(),
      });
    }
  }
}

function importSitesOfEntriesEntries(
  bound: string[],
  declaration: ImportDeclaration,
  named: ImportSpecifier[],
  names: string[],
  sites: ImportSite[],
  base: {
    fileKind: FileKind;
    resolvedFile: string;
    specifier: string;
    viaPackage: boolean;
    package?: string | undefined;
    file: string;
  },
  others: string[]
) {
  if (bound.length > 0) {
    const typeOnly =
      declaration.isTypeOnly() ||
      named
        .filter((n) => names.includes(n.getName()))
        .every((n) => n.isTypeOnly());
    sites.push({
      ...base,
      form: "import",
      kind: typeOnly ? "type" : "named",
      names: bound,
      otherNames: others,
      typeOnly,
    });
  }
}

// ---------------------------------------------------------------------------
// Movement closure

function isTypePosition(node: Node, stopAt: Node): boolean {
  let current: Node | undefined = node.getParent();
  while (current !== undefined && current !== stopAt) {
    if (Node.isTypeNode(current)) {
      return true;
    }
    if (
      Node.isInterfaceDeclaration(current) ||
      Node.isTypeAliasDeclaration(current)
    ) {
      return true;
    }
    if (
      Node.isHeritageClause(current) &&
      current.getToken() === SyntaxKind.ImplementsKeyword
    ) {
      return true;
    }
    current = current.getParent();
  }
  return false;
}

function isTypeDeclaration(node: Node): boolean {
  return Node.isInterfaceDeclaration(node) || Node.isTypeAliasDeclaration(node);
}

/** The top-level declaration of `file` that contains `node`, or undefined for nested and foreign nodes. */
function topLevelOwner(file: SourceFile, node: Node): Node | undefined {
  if (node.getSourceFile() !== file) {
    return undefined;
  }
  for (const declaration of topLevelDeclarations(file)) {
    const holder = Node.isVariableDeclaration(declaration)
      ? (declaration.getFirstAncestorByKind(SyntaxKind.VariableStatement) ??
        declaration)
      : declaration;
    if (
      holder === node ||
      holder.containsRange(node.getStart(), node.getEnd())
    ) {
      return declaration;
    }
  }
  return undefined;
}

function scanRoot(node: Node): Node {
  return Node.isVariableDeclaration(node)
    ? (node.getFirstAncestorByKind(SyntaxKind.VariableStatement) ?? node)
    : node;
}

function nameOf(node: Node): string {
  return Node.hasName(node) ? node.getName() : node.getText().slice(0, 32);
}

interface ImportBinding {
  declaration: ImportDeclaration;
  typeOnly: boolean;
}

/** The import declaration in `file` through which `symbol` (an alias) is bound. */
function importBindingOf(node: Node): ImportBinding | undefined {
  const declarations = node.getSymbol()?.getDeclarations() ?? [];
  for (const declaration of declarations) {
    if (Node.isImportSpecifier(declaration)) {
      const importDeclaration = declaration.getImportDeclaration();
      return {
        declaration: importDeclaration,
        typeOnly: importDeclaration.isTypeOnly() || declaration.isTypeOnly(),
      };
    }
    if (
      Node.isImportClause(declaration) ||
      Node.isNamespaceImport(declaration)
    ) {
      const importDeclaration = declaration.getFirstAncestorByKind(
        SyntaxKind.ImportDeclaration
      );
      if (importDeclaration === undefined) {
        continue;
      }
      return {
        declaration: importDeclaration,
        typeOnly: importDeclaration.isTypeOnly(),
      };
    }
  }
  return undefined;
}

export interface MovementClosureInput {
  roots: LocatedSymbol[];
  sourcePackage: string;
  targetPackage: string;
}

export interface MovementClosureResult {
  closure: PlannedMovementClosure;
  /** Same-module declarations that move with the roots, in file order. */
  internalNodes: Node[];
}

/**
 * What the roots need to keep their meaning after a move. Same-module
 * non-exported declarations move along unless remaining code needs them
 * too; everything imported becomes an import from wherever it lives
 * relative to the target.
 */
export function movementClosure(
  context: OperatorPlanningContext,
  input: MovementClosureInput
): MovementClosureResult {
  const [first] = input.roots;
  if (first === undefined) {
    return {
      closure: {
        complete: false,
        externalDependencies: [],
        requiredInternalSymbols: [],
        rootSymbols: [],
        sharedInternalSymbols: [],
      },
      internalNodes: [],
    };
  }
  const file = first.sourceFile;
  const fileRel = first.file;
  const rootNodes = new Set(input.roots.map((r) => r.node));
  const moving = new Set<Node>(rootNodes);
  const internal: Node[] = [];
  const external = new Map<string, PlannedClosureDependency>();
  const queue = [...rootNodes];

  const noteExternal = (
    id: string,
    name: string,
    cls: PlannedDependencyClass,
    pkg: string | undefined,
    typeOnly: boolean
  ) => {
    const existing = external.get(id);
    if (existing === undefined) {
      external.set(id, {
        class: cls,
        id,
        name,
        ...(pkg !== undefined && { package: pkg }),
        typeOnly,
      });
    } else if (!typeOnly) {
      existing.typeOnly = false;
    }
  };

  movementClosureEntries(
    queue,
    noteExternal,
    context,
    input,
    file,
    moving,
    fileRel,
    internal
  );

  const shared: string[] = [];
  const remaining = topLevelDeclarations(file).filter((d) => !moving.has(d));
  for (const node of internal) {
    const needed = remaining.some((other) =>
      scanRoot(other)
        .getDescendantsOfKind(SyntaxKind.Identifier)
        .some((identifier) =>
          (identifier.getSymbol()?.getDeclarations() ?? []).some(
            (d) => topLevelOwner(file, d) === node
          )
        )
    );
    if (needed) {
      shared.push(`${fileRel}#${nameOf(node)}`);
    }
  }
  const order = topLevelDeclarations(file);
  internal.sort((a, b) => order.indexOf(a) - order.indexOf(b));
  return {
    closure: {
      complete: shared.length === 0,
      externalDependencies: [...external.values()].sort((a, b) =>
        a.id.localeCompare(b.id)
      ),
      requiredInternalSymbols: internal
        .map((n) => `${fileRel}#${nameOf(n)}`)
        .sort((a, b) => a.localeCompare(b)),
      rootSymbols: input.roots
        .map((r) => r.id)
        .sort((a, b) => a.localeCompare(b)),
      sharedInternalSymbols: shared.sort((a, b) => a.localeCompare(b)),
    },
    internalNodes: internal,
  };
}

function movementClosureEntries(
  queue: Node[],
  noteExternal: (
    id: string,
    name: string,
    cls: PlannedDependencyClass,
    pkg: string | undefined,
    typeOnly: boolean
  ) => void,
  context: OperatorPlanningContext,
  input: MovementClosureInput,
  file: SourceFile,
  moving: Set<Node>,
  fileRel: string,
  internal: Node[]
) {
  while (queue.length > 0) {
    const current = queue.shift();
    if (current === undefined) {
      break;
    }
    const scanned = scanRoot(current);
    movementClosureEntriesIdentifier(
      scanned,
      noteExternal,
      context,
      input,
      file,
      moving,
      fileRel,
      internal,
      queue
    );
  }
}

function movementClosureEntriesIdentifier(
  scanned: Node,
  noteExternal: (
    id: string,
    name: string,
    cls: PlannedDependencyClass,
    pkg: string | undefined,
    typeOnly: boolean
  ) => void,
  context: OperatorPlanningContext,
  input: MovementClosureInput,
  file: SourceFile,
  moving: Set<Node>,
  fileRel: string,
  internal: Node[],
  queue: Node[]
) {
  for (const identifier of scanned.getDescendantsOfKind(
    SyntaxKind.Identifier
  )) {
    const symbol = identifier.getSymbol();
    if (symbol === undefined) {
      continue;
    }
    const binding = importBindingOf(identifier);
    const typePosition = isTypePosition(identifier, scanned);
    if (binding !== undefined) {
      const target = binding.declaration.getModuleSpecifierSourceFile();
      const specifier = binding.declaration.getModuleSpecifierValue();
      const typeOnly = binding.typeOnly || typePosition;
      if (
        target === undefined ||
        target.isInNodeModules() ||
        target.isDeclarationFile()
      ) {
        noteExternal(
          specifier,
          identifier.getText(),
          "external",
          undefined,
          typeOnly
        );
        continue;
      }
      const targetRel = relativeFile(context, target);
      const resolved = symbol.getAliasedSymbol() ?? symbol;
      const [declaration] = resolved.getDeclarations();
      const declarationFile =
        declaration === undefined
          ? targetRel
          : relativeFile(context, declaration.getSourceFile());
      const pkg = packageOfFile(context, declarationFile);
      const name =
        declaration !== undefined && Node.hasName(declaration)
          ? declaration.getName()
          : identifier.getText();

      const cls: PlannedDependencyClass =
        movementClosureEntriesIdentifierEntries(pkg, input);
      noteExternal(
        `${declarationFile}#${name}`,
        name,
        cls,
        pkg,
        typeOnly ||
          (declaration !== undefined && isTypeDeclaration(declaration))
      );
      continue;
    }
    movementClosureEntriesIdentifierDeclaration(
      symbol,
      file,
      moving,
      scanned,
      noteExternal,
      fileRel,
      input,
      typePosition,
      internal,
      queue
    );
  }
}

function movementClosureEntriesIdentifierEntries(
  pkg: string | undefined,
  input: MovementClosureInput
): PlannedDependencyClass {
  let cls: PlannedDependencyClass;
  if (pkg === undefined) {
    cls = "external";
  } else if (pkg === input.sourcePackage) {
    cls = "import-from-source-package";
  } else if (pkg === input.targetPackage) {
    cls = "import-from-target-package";
  } else {
    cls = "import-from-third-package";
  }
  return cls;
}

function movementClosureEntriesIdentifierDeclaration(
  symbol: MorphSymbol,
  file: SourceFile,
  moving: Set<Node>,
  scanned: Node,
  noteExternal: (
    id: string,
    name: string,
    cls: PlannedDependencyClass,
    pkg: string | undefined,
    typeOnly: boolean
  ) => void,
  fileRel: string,
  input: MovementClosureInput,
  typePosition: boolean,
  internal: Node[],
  queue: Node[]
) {
  for (const declaration of symbol.getDeclarations()) {
    if (declaration.getSourceFile() !== file) {
      continue;
    }
    const owner = topLevelOwner(file, declaration);
    if (owner === undefined || moving.has(owner)) {
      continue;
    }
    if (scanned.containsRange(declaration.getStart(), declaration.getEnd())) {
      continue;
    }
    if (exportedNamesOf(file, owner).length > 0) {
      noteExternal(
        `${fileRel}#${nameOf(owner)}`,
        nameOf(owner),
        "import-from-source-package",
        input.sourcePackage,
        typePosition || isTypeDeclaration(owner)
      );
      continue;
    }
    moving.add(owner);
    internal.push(owner);
    queue.push(owner);
  }
}

/** Top-level declarations of `file` that are neither roots nor closure internals. */
export function remainingDeclarations(
  file: SourceFile,
  moving: Set<Node>
): Node[] {
  return topLevelDeclarations(file).filter((d) => !moving.has(d));
}

/** `import "./x"` and top-level statements that run on load. */
export function hasSideEffects(file: SourceFile): boolean {
  for (const declaration of file.getImportDeclarations()) {
    if (declaration.getImportClause() === undefined) {
      return true;
    }
  }
  return file
    .getStatements()
    .some(
      (statement) =>
        !(
          Node.isImportDeclaration(statement) ||
          Node.isExportDeclaration(statement) ||
          Node.isFunctionDeclaration(statement) ||
          Node.isClassDeclaration(statement) ||
          Node.isInterfaceDeclaration(statement) ||
          Node.isTypeAliasDeclaration(statement) ||
          Node.isEnumDeclaration(statement) ||
          Node.isModuleDeclaration(statement) ||
          Node.isVariableStatement(statement)
        )
    );
}

// ---------------------------------------------------------------------------
// Exposure routes

const entrypointCache = new WeakMap<
  OperatorPlanningPackage,
  { contexts: EntrypointContext[]; unresolved: string[] }
>();

function entrypointContexts(
  context: OperatorPlanningContext,
  pkg: OperatorPlanningPackage
): { contexts: EntrypointContext[]; unresolved: string[] } {
  let cached = entrypointCache.get(pkg);
  if (cached === undefined) {
    cached = buildEntrypointContexts(context.project, pkg.boundary);
    entrypointCache.set(pkg, cached);
  }
  return cached;
}

export interface ExposureRoutes {
  /** Package-internal modules import the symbol through an entrypoint. */
  internalEntrypointImporters: boolean;
  routes: ResolvedRoute[];
  unresolvedEntrypoints: string[];
}

/** How `pkg`'s declared entrypoints expose the symbol; empty when they do not. */
export function exposureRoutes(
  context: OperatorPlanningContext,
  pkg: OperatorPlanningPackage,
  symbol: LocatedSymbol
): ExposureRoutes {
  const { contexts, unresolved } = entrypointContexts(context, pkg);
  const routes: ResolvedRoute[] = [];
  let internalEntrypointImporters = false;
  for (const entry of contexts) {
    const names = entry.exposedNames.get(symbol.node);
    if (names === undefined) {
      continue;
    }
    for (const name of [...names].sort((a, b) => a.localeCompare(b))) {
      routes.push(
        resolveRoute(
          context.root,
          entry,
          entry.entrypoint === pkg.boundary.packageName,
          { declarationFile: symbol.file, name: symbol.name },
          symbol.node,
          name
        )
      );
      if (entry.internallyImportedNames.has(name) || entry.namespaceImported) {
        internalEntrypointImporters = true;
      }
    }
  }
  return {
    internalEntrypointImporters,
    routes,
    unresolvedEntrypoints: unresolved,
  };
}

/** Relative import specifier from `fromFile` to `toFile`, both root-relative, extension dropped. */
export function relativeSpecifier(fromFile: string, toFile: string): string {
  const target = toFile.replace(targetPattern, "");
  let relative = posix.relative(posix.dirname(fromFile), target);
  if (!relative.startsWith(".")) {
    relative = `./${relative}`;
  }
  return relative;
}

// ---------------------------------------------------------------------------
// Package graph

export interface PackageImportEdge {
  from: string;
  runtimeSites: number;
  /** Import and re-export declarations carrying the edge. */
  sites: number;
  to: string;
}

const graphCache = new WeakMap<Project, PackageImportEdge[]>();

/** `import type { A }` or `import { type A, type B }`: no runtime code follows the edge. */
function typeOnlyDeclaration(
  declaration: ImportDeclaration | ExportDeclaration
): boolean {
  if (declaration.isTypeOnly()) {
    return true;
  }
  if (Node.isImportDeclaration(declaration)) {
    const named = declaration.getNamedImports();
    return (
      named.length > 0 &&
      declaration.getDefaultImport() === undefined &&
      declaration.getNamespaceImport() === undefined &&
      named.every((n) => n.isTypeOnly())
    );
  }
  const named = declaration.getNamedExports();
  return named.length > 0 && named.every((n) => n.isTypeOnly());
}

/** Package → package edges as the sources import today, from every parsed file. */
export function packageImportEdges(
  context: OperatorPlanningContext
): PackageImportEdge[] {
  const cached = graphCache.get(context.project);
  if (cached !== undefined) {
    return cached;
  }
  const edges = new Map<string, PackageImportEdge>();
  for (const [target, entries] of specifierIndex(context).byTarget) {
    const targetFile = context.project.getSourceFile(target);
    if (targetFile === undefined) {
      continue;
    }
    const to = packageOfFile(context, relativeFile(context, targetFile));
    if (to === undefined) {
      continue;
    }
    for (const { file, declaration } of entries) {
      const from = packageOfFile(context, relativeFile(context, file));
      if (from === undefined || from === to) {
        continue;
      }
      const id = `${from}→${to}`;
      const edge = edges.get(id) ?? { from, runtimeSites: 0, sites: 0, to };
      edge.sites += 1;
      if (!typeOnlyDeclaration(declaration)) {
        edge.runtimeSites += 1;
      }
      edges.set(id, edge);
    }
  }
  const result = [...edges.values()].sort(
    (a, b) => a.from.localeCompare(b.from) || a.to.localeCompare(b.to)
  );
  graphCache.set(context.project, result);
  return result;
}

/** Cycles through `added` edges in the graph `edges ∪ added`, as package lists. */
export function cyclesThrough(
  edges: { from: string; to: string }[],
  added: { from: string; to: string }[]
): string[][] {
  const adjacency = new Map<string, Set<string>>();
  for (const edge of [...edges, ...added]) {
    const set = adjacency.get(edge.from) ?? new Set<string>();
    set.add(edge.to);
    adjacency.set(edge.from, set);
  }
  const cycles: string[][] = [];
  const seen = new Set<string>();
  cyclesThroughEdge(added, seen, cycles, adjacency);
  return cycles.sort((a, b) => a.join("|").localeCompare(b.join("|")));
}

function cyclesThroughEdge(
  added: { from: string; to: string }[],
  seen: Set<string>,
  cycles: string[][],
  adjacency: Map<string, Set<string>>
) {
  for (const edge of added) {
    // A path from edge.to back to edge.from closes a cycle through the edge.
    const stack: string[][] = [[edge.to]];
    const visited = new Set<string>([edge.to]);
    cyclesThroughEdgeEntries(stack, edge, seen, cycles, adjacency, visited);
  }
}

function cyclesThroughEdgeEntries(
  stack: string[][],
  edge: { from: string; to: string },
  seen: Set<string>,
  cycles: string[][],
  adjacency: Map<string, Set<string>>,
  visited: Set<string>
) {
  while (stack.length > 0) {
    const pathSoFar = stack.pop();
    if (pathSoFar === undefined) {
      break;
    }
    const last = pathSoFar.at(-1);
    if (last === undefined) {
      continue;
    }
    if (last === edge.from) {
      const cycle = [...pathSoFar];
      const key = [...cycle].sort((a, b) => a.localeCompare(b)).join("|");
      if (!seen.has(key)) {
        seen.add(key);
        cycles.push(cycle);
      }
      continue;
    }
    for (const next of [...(adjacency.get(last) ?? [])].sort((a, b) =>
      a.localeCompare(b)
    )) {
      if (next === edge.from) {
        stack.push([...pathSoFar, next]);
        continue;
      }
      if (visited.has(next)) {
        continue;
      }
      visited.add(next);
      stack.push([...pathSoFar, next]);
    }
  }
}
