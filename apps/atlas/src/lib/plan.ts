import { relative, resolve } from "node:path";
import type { ExportDeclaration, Node, Project, SourceFile } from "ts-morph";

import type { Boundary } from "./boundary";
import { boundaryContains, boundaryEntrypoints, toPosix } from "./boundary";
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

export interface EntrypointContext {
  entrypoint: string;
  /** Declaration node → names it is exposed under from this entrypoint. */
  exposedNames: Map<Node, string[]>;
  file: SourceFile;
  fileRel: string;
  /** Names other boundary modules import from this entrypoint. */
  internallyImportedNames: Set<string>;
  /** A boundary module namespace-imports this entrypoint. */
  namespaceImported: boolean;
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

  for (const entry of boundaryEntrypoints(boundary)) {
    const file = project.getSourceFile(resolve(boundary.root, entry.file));
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
    const internallyImportedNames = new Set<string>();
    let namespaceImported = false;
    namespaceImported = buildEntrypointContextsOther(
      boundaryFiles,
      file,
      namespaceImported,
      internallyImportedNames
    );
    contexts.push({
      entrypoint: entry.entrypoint,
      exposedNames,
      file,
      fileRel: entry.file,
      internallyImportedNames,
      namespaceImported,
    });
  }
  return { contexts, unresolved };
}

const exportedNodesCache = new WeakMap<SourceFile, Set<Node>>();

function buildEntrypointContextsOther(
  boundaryFiles: SourceFile[],
  file: SourceFile,
  initialNamespaceImported: boolean,
  internallyImportedNames: Set<string>
) {
  let namespaceImported = initialNamespaceImported;
  for (const other of boundaryFiles) {
    if (other === file) {
      continue;
    }
    for (const declaration of other.getImportDeclarations()) {
      if (declaration.getModuleSpecifierSourceFile() !== file) {
        continue;
      }
      if (declaration.getNamespaceImport() !== undefined) {
        namespaceImported = true;
      }
      for (const named of declaration.getNamedImports()) {
        internallyImportedNames.add(named.getName());
      }
    }
  }
  return namespaceImported;
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
  fullyEnumerable: boolean
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
      hasDirect
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

  let preservedBehavior: string[];
  if (status === "unsupported") {
    preservedBehavior = [];
  } else {
    preservedBehavior = [
      `Declaration remains in ${symbol.declarationFile}`,
      "Internal imports and references remain unchanged",
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
  initialHasDirect: boolean
): { unsupported: boolean; hasDirect: boolean } {
  let hasDirect = initialHasDirect;
  let unsupported = initialUnsupported;
  for (const { route, declaration, direct, context } of resolved) {
    if (route.kind === "star-export") {
      unsupported = true;
      blockers.push({
        detail: `${symbol.name} is exposed through "${route.statement ?? "export *"}" in ${route.file}; selective internalization would require rewriting the star export.`,
        reason: "star-export",
      });
      plannedChanges.push({
        description: `No precise change: ${symbol.name} is exposed through a star export.`,
        file: route.file,
        kind: "unsupported",
      });
      continue;
    }
    if (route.kind === "other") {
      unsupported = true;
      blockers.push({
        detail: `The exposure of ${symbol.name} from ${route.file} does not match a recognized export form.`,
        reason: "unrecognized-route",
      });
      plannedChanges.push({
        description: `No precise change: the exposure of ${symbol.name} is not a recognized export form.`,
        file: route.file,
        kind: "unsupported",
      });
      continue;
    }
    // Internal imports of the entrypoint break for any route kind: a boundary
    // module importing this name (or the whole namespace) from the entrypoint
    // relies on the exposure the plan would remove.
    if (context.namespaceImported) {
      unsupported = true;
      blockers.push({
        detail: `${route.file} is namespace-imported inside the package; internal use of ${symbol.name} cannot be ruled out.`,
        reason: "namespace-import",
      });
      plannedChanges.push({
        description: `No precise change: ${route.file} is namespace-imported inside the package.`,
        file: route.file,
        kind: "unsupported",
      });
      continue;
    }
    if (context.internallyImportedNames.has(route.exportedName)) {
      unsupported = true;
      blockers.push({
        detail: `${route.exportedName} is imported from the entrypoint by other modules in the package; removing its public export would break them.`,
        reason: "internal-entrypoint-import",
      });
      plannedChanges.push({
        description: `No precise change: ${route.exportedName} is imported from the entrypoint inside the package.`,
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
      fullyEnumerable
    );
  });
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
