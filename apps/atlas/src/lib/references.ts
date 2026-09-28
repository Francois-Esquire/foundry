import { relative } from "node:path";
import type { Node, SourceFile } from "ts-morph";

import { SyntaxKind } from "ts-morph";

import type { Boundary } from "./boundary";
import {
  boundaryContains,
  classifySpecifier,
  ownerBoundary,
  toPosix,
} from "./boundary";
import type {
  ConsumerModuleUsage,
  ConsumerUsage,
  SymbolAccess,
  UsageContext,
  UsageNamespace,
} from "./types";
import { classifyReference } from "./usage";

export interface ExternalUsage {
  access: SymbolAccess;
  consumerModules: string[];
  consumerModuleUsage: ConsumerModuleUsage[];
  consumerPackages: string[];
  consumers: ConsumerUsage[];
  externalImportSites: number;
  externalReferences: number;
  primaryConsumerShare: number;
  usageContexts: Partial<Record<UsageContext, number>>;
  usageNamespace: UsageNamespace;
}

export function emptyUsage(): ExternalUsage {
  return {
    access: "unused",
    consumerModules: [],
    consumerModuleUsage: [],
    consumerPackages: [],
    consumers: [],
    externalImportSites: 0,
    externalReferences: 0,
    primaryConsumerShare: 0,
    usageContexts: {},
    usageNamespace: "none",
  };
}

function namespaceOf(spaces: Set<"type" | "value">): UsageNamespace {
  return spaces.size === 2 ? "both" : (spaces.values().next().value ?? "none");
}

interface ImportSite {
  reExport: boolean;
  specifier?: string;
  typeOnly: boolean;
}

function importSiteOf(ref: Node): ImportSite | undefined {
  const importSpecifier = ref.getFirstAncestorByKind(
    SyntaxKind.ImportSpecifier
  );
  if (importSpecifier) {
    const declaration = importSpecifier.getImportDeclaration();
    return {
      reExport: false,
      specifier: declaration.getModuleSpecifierValue(),
      typeOnly: importSpecifier.isTypeOnly() || declaration.isTypeOnly(),
    };
  }
  const exportSpecifier = ref.getFirstAncestorByKind(
    SyntaxKind.ExportSpecifier
  );
  if (exportSpecifier) {
    const declaration = exportSpecifier.getExportDeclaration();
    return {
      reExport: true,
      specifier: declaration.getModuleSpecifierValue(),
      typeOnly: exportSpecifier.isTypeOnly() || declaration.isTypeOnly(),
    };
  }
  const importClause = ref.getFirstAncestorByKind(SyntaxKind.ImportClause);
  if (importClause?.getDefaultImport() === ref) {
    const declaration = importClause.getParentIfKind(
      SyntaxKind.ImportDeclaration
    );
    return {
      reExport: false,
      specifier: declaration?.getModuleSpecifierValue(),
      typeOnly: importClause.isTypeOnly(),
    };
  }
  return undefined;
}

/**
 * When a symbol is used externally but never named in an import specifier
 * (e.g. reached via a namespace import), derive access from how the consumer
 * file imports the boundary at all.
 */
function fileAccess(
  file: SourceFile,
  boundary: Boundary
): Set<"public" | "deep"> {
  const access = new Set<"public" | "deep">();
  for (const declaration of file.getImportDeclarations()) {
    const specifier = declaration.getModuleSpecifierValue();
    if (
      boundary.packageName &&
      (specifier === boundary.packageName ||
        specifier.startsWith(`${boundary.packageName}/`))
    ) {
      access.add(classifySpecifier(boundary, specifier));
      continue;
    }
    const resolved = declaration.getModuleSpecifierSourceFile();
    if (resolved && boundaryContains(boundary, resolved.getFilePath())) {
      access.add("deep");
    }
  }
  return access;
}

/**
 * External usage from an already-resolved reference list — every node that
 * names the symbol, in any file. The V12.6 reference index supplies the
 * list once for the whole workspace, reproducing what one
 * `findReferencesAsNodes` call per symbol returned before it.
 */
export function usageFromReferences(
  referenceNodes: Iterable<Node>,
  boundary: Boundary
): ExternalUsage {
  const consumers = new Map<string, ConsumerCounts>();
  const consumerModules = new Set<string>();
  const moduleUsage = new Map<string, ConsumerModuleUsage>();
  const consumerFiles = new Map<string, SourceFile>();
  const spaces = new Set<"type" | "value">();
  const accessSet = new Set<"public" | "deep">();
  const usageContexts: Partial<Record<UsageContext, number>> = {};
  let references = 0;
  let importSites = 0;

  const bump = (context: UsageContext, consumer: ConsumerCounts) => {
    usageContexts[context] = (usageContexts[context] ?? 0) + 1;
    consumer.contexts[context] = (consumer.contexts[context] ?? 0) + 1;
  };
  const visitRef = () => {
    ({ importSites, references } = usageFromReferencesRef(
      referenceNodes,
      boundary,
      consumerModules,
      consumerFiles,
      consumers,
      moduleUsage,
      importSites,
      accessSet,
      spaces,
      bump,
      references
    ));
  };

  visitRef();

  if (references + importSites === 0) {
    return emptyUsage();
  }

  if (accessSet.size === 0) {
    for (const file of consumerFiles.values()) {
      for (const value of fileAccess(file, boundary)) {
        accessSet.add(value);
      }
    }
  }

  const sortedConsumers: ConsumerUsage[] = [...consumers.entries()]
    .map(([consumerBoundary, counts]) => ({
      boundary: consumerBoundary,
      importSites: counts.importSites,
      references: counts.references,
      usageContexts: counts.contexts,
      usageNamespace: namespaceOf(counts.spaces),
    }))
    .sort(
      (a, b) =>
        b.references - a.references ||
        b.importSites - a.importSites ||
        a.boundary.localeCompare(b.boundary)
    );

  const [primary] = sortedConsumers;
  const primaryConsumerShare =
    references > 0 && primary ? primary.references / references : 0;

  const usageNamespace = namespaceOf(spaces);

  const access: SymbolAccess =
    accessSet.size === 2
      ? "both"
      : (accessSet.values().next().value ?? "public");

  return {
    access,
    consumerModules: [...consumerModules].sort(),
    consumerModuleUsage: [...moduleUsage.values()].sort((a, b) =>
      a.module.localeCompare(b.module)
    ),
    consumerPackages: [...consumers.keys()].sort(),
    consumers: sortedConsumers,
    externalImportSites: importSites,
    externalReferences: references,
    primaryConsumerShare,
    usageContexts,
    usageNamespace,
  };
}

function usageFromReferencesRef(
  referenceNodes: Iterable<Node>,
  boundary: Boundary,
  consumerModules: Set<string>,
  consumerFiles: Map<string, SourceFile>,
  consumers: Map<string, ConsumerCounts>,
  moduleUsage: Map<string, ConsumerModuleUsage>,
  initialImportSites: number,
  accessSet: Set<"public" | "deep">,
  spaces: Set<"type" | "value">,
  bump: (context: UsageContext, consumer: ConsumerCounts) => void,
  initialReferences: number
) {
  let references = initialReferences;
  let importSites = initialImportSites;
  for (const ref of referenceNodes) {
    const file = ref.getSourceFile();
    const filePath = file.getFilePath();
    if (boundaryContains(boundary, filePath)) {
      continue;
    }
    if (filePath.includes("/node_modules/")) {
      continue;
    }

    const relFile = toPosix(relative(boundary.root, filePath));
    const owner = ownerBoundary(boundary.root, filePath);
    consumerModules.add(relFile);
    consumerFiles.set(filePath, file);
    const consumer = consumers.get(owner) ?? {
      contexts: {},
      importSites: 0,
      references: 0,
      spaces: new Set<"type" | "value">(),
    };
    consumers.set(owner, consumer);
    const moduleCounts = moduleUsage.get(relFile) ?? {
      importSites: 0,
      module: relFile,
      package: owner,
      references: 0,
    };
    moduleUsage.set(relFile, moduleCounts);

    const site = importSiteOf(ref);
    if (site) {
      importSites += 1;
      consumer.importSites += 1;
      moduleCounts.importSites += 1;
      if (site.specifier !== undefined) {
        accessSet.add(classifySpecifier(boundary, site.specifier));
      }
      if (site.typeOnly) {
        spaces.add("type");
        consumer.spaces.add("type");
      }
      if (site.reExport) {
        bump("re-export", consumer);
      }
      continue;
    }

    references += 1;
    consumer.references += 1;
    moduleCounts.references += 1;
    const { context, space } = classifyReference(ref);
    bump(context, consumer);
    if (space !== "unknown") {
      spaces.add(space);
      consumer.spaces.add(space);
    }
  }
  return { importSites, references };
}
interface ConsumerCounts {
  contexts: Partial<Record<UsageContext, number>>;
  importSites: number;
  references: number;
  spaces: Set<"type" | "value">;
}
