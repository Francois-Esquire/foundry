import { relative } from "node:path";
import type { Project, SourceFile } from "ts-morph";
import { Node, SyntaxKind, ts } from "ts-morph";
import type { Boundary } from "./boundary";
import { ownerBoundary, toPosix } from "./boundary";
import type { AnalysisConfig } from "./config";
import { ANALYSIS_CONFIG } from "./config";
import type { CollectedSymbol } from "./symbols";
import { kindOf } from "./symbols";
import type {
  ConceptDistribution,
  ConceptEvidence,
  ConceptFamily,
  ConceptInventoryReport,
  ConceptRelationshipKind,
  ConceptRepresentation,
  ConceptRepresentationRelationship,
  ConceptSeed,
  ConceptSeedKind,
  SurfaceSymbol,
  SymbolKind,
} from "./types";
import { classifyReference } from "./usage";

export interface ConceptInventorySource {
  boundary: Boundary;
  project: Project;
  /** Surface facts for the same inventory, matched by id. */
  surface: SurfaceSymbol[];
  /** Symbol inventory with declaration nodes (target-scoped). */
  symbols: CollectedSymbol[];
}

interface ConceptSeedState {
  evidence: ConceptEvidence[];
  seed: ConceptSeed;
}

/** One package's seeds keyed by declaration node, ready for the evidence sweep. */
export interface ConceptSeedGroup {
  boundary: Boundary;
  byNode: Map<ts.Node, ConceptSeedState>;
  states: ConceptSeedState[];
}

const RELATIONSHIP_KINDS: ConceptRelationshipKind[] = [
  "implements",
  "extends",
  "alias",
  "type-reference",
  "parameter-type",
  "return-type",
  "property-type",
  "constructs",
];

const REPRESENTATION_OF: Record<
  ConceptRelationshipKind,
  ConceptRepresentationRelationship
> = {
  alias: "alias",
  constructs: "other",
  extends: "extension",
  implements: "implementation",
  "parameter-type": "type-user",
  "property-type": "type-user",
  "return-type": "factory",
  "type-reference": "type-user",
};

const REPRESENTATION_ORDER: ConceptRepresentationRelationship[] = [
  "implementation",
  "extension",
  "alias",
  "factory",
  "type-user",
  "other",
];

function isSeedKind(
  kind: SymbolKind,
  seedKinds: ConceptSeedKind[]
): kind is ConceptSeedKind {
  return (seedKinds as string[]).includes(kind);
}

/** Nearest top-level statement of the file containing `node`. */
function topLevelOwner(node: Node): Node | undefined {
  const statement = node.getFirstAncestor((ancestor) =>
    Node.isSourceFile(ancestor.getParent())
  );
  if (statement === undefined) {
    return undefined;
  }
  if (Node.isVariableStatement(statement)) {
    const start = node.getStart();
    return statement
      .getDeclarations()
      .find((declaration) => declaration.containsRange(start, start));
  }
  return statement;
}

/** The target's seeds with their declaration evidence; no workspace has been read yet. */
export function prepareConceptSeeds(
  source: Omit<ConceptInventorySource, "project">,
  config: AnalysisConfig = ANALYSIS_CONFIG
): ConceptSeedGroup {
  const { boundary } = source;
  const { root } = boundary;
  const surfaceById = new Map(source.surface.map((s) => [s.id, s]));
  const seedByNode = new Map<ts.Node, ConceptSeedState>();
  const seeds: ConceptSeedState[] = [];
  const seenIds = new Set<string>();

  for (const collected of source.symbols) {
    if (!isSeedKind(collected.kind, config.concepts.seedKinds)) {
      continue;
    }
    if (seenIds.has(collected.id)) {
      continue;
    }
    seenIds.add(collected.id);
    const surface = surfaceById.get(collected.id);
    const file = collected.declarationFile;
    const seed: ConceptSeed = {
      declaration: {
        file,
        package: ownerBoundary(
          root,
          collected.node.getSourceFile().getFilePath()
        ),
      },
      id: collected.id,
      kind: collected.kind,
      name: collected.name,
      surface: {
        externallyUsed:
          surface !== undefined &&
          surface.externalReferences + surface.externalImportSites > 0,
        moduleExported: surface?.exported ?? collected.exported,
        packagePublic: surface?.packagePublic ?? false,
      },
    };
    const state: ConceptSeedState = {
      evidence: [
        {
          file,
          kind: "declaration",
          line: collected.startLine,
          package: seed.declaration.package,
          target: seed.id,
        },
      ],
      seed,
    };
    seeds.push(state);
    seedByNode.set(collected.node.compilerNode, state);
  }
  return { boundary, byNode: seedByNode, states: seeds };
}

/**
 * One pass over every workspace file attaching relationship evidence to the
 * seeds of every group at once. A reference resolves per group to the first
 * of its symbol's declarations that group seeds, exactly as a single-group
 * sweep would; groups never see each other's evidence.
 */
export function sweepConceptEvidence(
  project: Project,
  root: string,
  groups: ConceptSeedGroup[]
): void {
  const active = groups.filter((group) => group.states.length > 0);
  if (active.length === 0) {
    return;
  }
  const checker = project.getTypeChecker().compilerObject;
  const seedsOf = (node: Node): ConceptSeedState[] => {
    let symbol = checker.getSymbolAtLocation(node.compilerNode);
    if (symbol === undefined) {
      return [];
    }
    // biome-ignore lint/suspicious/noBitwiseOperators: TypeScript exposes these properties as bit flags.
    if (symbol.flags & ts.SymbolFlags.Alias) {
      symbol = checker.getAliasedSymbol(symbol);
    }
    const found: ConceptSeedState[] = [];
    const matched = new Set<ConceptSeedGroup>();
    seedsOfDeclaration(symbol, active, matched, found);
    return found;
  };
  const groupOfSeed = new Map<ConceptSeedState, ConceptSeedGroup>();
  for (const group of active) {
    for (const state of group.states) {
      groupOfSeed.set(state, group);
    }
  }

  const record = (
    seed: ConceptSeedState,
    kind: ConceptRelationshipKind,
    at: Node,
    relFile: string,
    owner: string
  ) => {
    const top = topLevelOwner(at);
    if (
      top !== undefined &&
      groupOfSeed.get(seed)?.byNode.get(top.compilerNode) === seed
    ) {
      return;
    }
    const name =
      top !== undefined && Node.hasName(top) ? top.getName() : undefined;
    seed.evidence.push({
      kind,
      ...(top !== undefined &&
        name !== undefined && {
          source: {
            kind: kindOf(top),
            name,
            symbolId: `${relFile}#${name}`,
          },
        }),
      file: relFile,
      line: at.getStartLineNumber(),
      package: owner,
      target: seed.seed.id,
    });
  };

  sweepConceptEvidenceFile(project, root, seedsOf, record);
}

function sweepConceptEvidenceFile(
  project: Project,
  root: string,
  seedsOf: (node: Node) => ConceptSeedState[],
  record: (
    seed: ConceptSeedState,
    kind: ConceptRelationshipKind,
    at: Node,
    relFile: string,
    owner: string
  ) => void
) {
  for (const file of project.getSourceFiles()) {
    const filePath = file.getFilePath();
    if (file.isDeclarationFile() || filePath.includes("/node_modules/")) {
      continue;
    }
    const relFile = toPosix(relative(root, filePath));
    const owner = ownerBoundary(root, filePath);

    sweepConceptEvidenceFileReference(file, seedsOf, record, relFile, owner);

    sweepConceptEvidenceFileExpression(file, seedsOf, record, relFile, owner);

    for (const construction of file.getDescendantsOfKind(
      SyntaxKind.NewExpression
    )) {
      for (const seed of seedsOf(construction.getExpression())) {
        record(seed, "constructs", construction, relFile, owner);
      }
    }
  }
}

function sweepConceptEvidenceFileExpression(
  file: SourceFile,
  seedsOf: (node: Node) => ConceptSeedState[],
  record: (
    seed: ConceptSeedState,
    kind: ConceptRelationshipKind,
    at: Node,
    relFile: string,
    owner: string
  ) => void,
  relFile: string,
  owner: string
) {
  for (const expression of file.getDescendantsOfKind(
    SyntaxKind.ExpressionWithTypeArguments
  )) {
    const clause = expression.getParent();
    if (!Node.isHeritageClause(clause)) {
      continue;
    }
    const seeds = seedsOf(expression.getExpression());
    if (seeds.length === 0) {
      continue;
    }
    const kind =
      clause.getToken() === SyntaxKind.ImplementsKeyword
        ? "implements"
        : "extends";
    for (const seed of seeds) {
      record(seed, kind, expression, relFile, owner);
    }
  }
}

function sweepConceptEvidenceFileReference(
  file: SourceFile,
  seedsOf: (node: Node) => ConceptSeedState[],
  record: (
    seed: ConceptSeedState,
    kind: ConceptRelationshipKind,
    at: Node,
    relFile: string,
    owner: string
  ) => void,
  relFile: string,
  owner: string
) {
  for (const reference of file.getDescendantsOfKind(SyntaxKind.TypeReference)) {
    const typeName = reference.getTypeName();
    const seeds = seedsOf(typeName);
    if (seeds.length === 0) {
      continue;
    }
    const parent = reference.getParent();
    if (
      Node.isTypeAliasDeclaration(parent) &&
      parent.getTypeNode() === reference
    ) {
      for (const seed of seeds) {
        record(seed, "alias", reference, relFile, owner);
      }
      continue;
    }
    const { context } = classifyReference(typeName);
    const kind: ConceptRelationshipKind =
      context === "parameter-type" ||
      context === "return-type" ||
      context === "property-type"
        ? context
        : "type-reference";
    for (const seed of seeds) {
      record(seed, kind, reference, relFile, owner);
    }
  }
}

function seedsOfDeclaration(
  symbol: ts.Symbol,
  active: ConceptSeedGroup[],
  matched: Set<ConceptSeedGroup>,
  found: ConceptSeedState[]
) {
  for (const declaration of symbol.declarations ?? []) {
    for (const group of active) {
      if (matched.has(group)) {
        continue;
      }
      const seed = group.byNode.get(declaration);
      if (seed === undefined) {
        continue;
      }
      matched.add(group);
      found.push(seed);
    }
    if (matched.size === active.length) {
      break;
    }
  }
}

/** The inventory report from swept seeds; `surface` supplies package-public flags for representations. */
export function buildConceptInventory(
  group: ConceptSeedGroup,
  surface: SurfaceSymbol[]
): ConceptInventoryReport {
  const { boundary } = group;
  const surfaceById = new Map(surface.map((s) => [s.id, s]));
  const families = group.states
    .map((state) => buildFamily(state, surfaceById))
    .sort(
      (a, b) =>
        b.distribution.packageCount - a.distribution.packageCount ||
        b.distribution.moduleCount - a.distribution.moduleCount ||
        b.distribution.references - a.distribution.references ||
        a.seed.name.localeCompare(b.seed.name) ||
        a.seed.id.localeCompare(b.seed.id)
    );

  return {
    families,
    summary: {
      aliases: families.reduce(
        (sum, family) => sum + family.relationships.alias,
        0
      ),
      crossPackageFamilies: families.filter(
        (family) => family.distribution.packageCount > 1
      ).length,
      distributedFamilies: families.filter(
        (family) => family.distribution.moduleCount > 1
      ).length,
      families: families.length,
      implementations: families.reduce(
        (sum, family) => sum + family.relationships.implements,
        0
      ),
      seeds: families.length,
    },
    target: boundary.packageName ?? boundary.relPath,
  };
}

function buildFamily(
  state: ConceptSeedState,
  surfaceById: Map<string, SurfaceSymbol>
): ConceptFamily {
  const evidence = [...state.evidence].sort(
    (a, b) =>
      a.file.localeCompare(b.file) ||
      a.line - b.line ||
      a.kind.localeCompare(b.kind)
  );
  const relationships = Object.fromEntries(
    RELATIONSHIP_KINDS.map((kind) => [kind, 0])
  ) as Record<ConceptRelationshipKind, number>;
  const representations = new Map<string, ConceptRepresentation>();
  const packages = new Set<string>();
  const modules = new Set<string>();
  let references = 0;

  for (const item of evidence) {
    packages.add(item.package);
    modules.add(item.file);
    if (item.kind === "declaration") {
      continue;
    }
    references += 1;
    relationships[item.kind] += 1;
    if (item.source === undefined) {
      continue;
    }
    const relationship = REPRESENTATION_OF[item.kind];
    const key = `${item.source.symbolId}#${relationship}`;
    const existing = representations.get(key);
    if (existing !== undefined) {
      existing.occurrences += 1;
      continue;
    }
    representations.set(key, {
      file: item.file,
      kind: item.source.kind,
      name: item.source.name,
      occurrences: 1,
      package: item.package,
      relationship,
      symbolId: item.source.symbolId,
    });
  }

  const sortedRepresentations = [...representations.values()].sort(
    (a, b) =>
      REPRESENTATION_ORDER.indexOf(a.relationship) -
        REPRESENTATION_ORDER.indexOf(b.relationship) ||
      a.package.localeCompare(b.package) ||
      a.name.localeCompare(b.name) ||
      a.symbolId.localeCompare(b.symbolId)
  );

  const distribution: ConceptDistribution = {
    moduleCount: modules.size,
    modules: [...modules].sort(),
    packageCount: packages.size,
    packagePublicRepresentations: sortedRepresentations.filter(
      (representation) =>
        surfaceById.get(representation.symbolId)?.packagePublic === true
    ).length,
    packages: [...packages].sort(),
    references,
  };

  return {
    distribution,
    evidence,
    relationships,
    representations: sortedRepresentations,
    seed: state.seed,
  };
}
