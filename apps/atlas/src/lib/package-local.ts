import * as fs from "node:fs";
import * as path from "node:path";
import type { SourceFile } from "ts-morph";

import { Node, Project, SyntaxKind, ts } from "ts-morph";
import { anchorFor } from "./anchors";
import type { Boundary } from "./boundary";
import {
  boundaryEntrypoints,
  findRepoRoot,
  packagePathAliases,
  resolveBoundary,
  toPosix,
} from "./boundary";
import type { ConceptSeedGroup } from "./concepts";
import { prepareConceptSeeds, sweepConceptEvidence } from "./concepts";
import type { AnalysisConfig } from "./config";
import { ANALYSIS_CONFIG, ANALYSIS_POLICY_VERSION } from "./config";
import { classifyFile } from "./file-kind";
import { analyzeLocalComplexity } from "./local-complexity";
import { collectModuleRoles } from "./module-roles";
import type {
  PackageLocalAliasShape,
  PackageLocalBindingUses,
  PackageLocalConceptParticipation,
  PackageLocalConceptSeed,
  PackageLocalDeclaration,
  PackageLocalDefaultExport,
  PackageLocalImport,
  PackageLocalInitializer,
  PackageLocalReport,
  PackageLocalSymbol,
} from "./package-local-types";
import { PACKAGE_LOCAL_REPORT_SCHEMA_VERSION } from "./package-local-types";
import { packageSourceFiles } from "./project";
import { packagePublicNodes } from "./scope";
import type { CollectedSymbol } from "./symbols";
import { collectSymbols } from "./symbols";
import type {
  ConceptRelationshipKind,
  ConceptSeedKind,
  SymbolKind,
} from "./types";

// V12.6 package-local analysis. Everything here is a function of one
// package's own sources and manifest: the project is an in-memory file
// system holding exactly the package-owned files, so an import of another
// workspace package cannot resolve and nothing outside the boundary is ever
// read. Facts that need the rest of the workspace — who uses a symbol, how
// far a module reaches, which concepts overlap, what history says — are
// derived once per workspace from these reports (workspace-derive.ts).
//
// Invariant: an unchanged package yields a byte-identical report in any
// workspace, under any Git history, on any day.

export interface AnalyzePackageLocalOptions {
  config?: AnalysisConfig;
  root?: string;
  target: string;
  /** Optional tsconfig whose `paths` into the package are honoured. */
  tsconfig?: string;
}

function tsconfigPathsInto(
  root: string,
  tsconfig: string,
  boundary: Boundary
): Record<string, string[]> {
  const file = path.resolve(root, tsconfig);
  const read = ts.readConfigFile(file, (name) => fs.readFileSync(name, "utf8"));
  const raw = read.config as
    | {
        compilerOptions?: {
          baseUrl?: string;
          paths?: Record<string, string[]>;
        };
      }
    | undefined;
  const options = raw?.compilerOptions;
  if (options?.paths === undefined) {
    return {};
  }
  const base = path.resolve(path.dirname(file), options.baseUrl ?? ".");
  const inside: Record<string, string[]> = {};
  for (const [key, targets] of Object.entries(options.paths)) {
    const owned = targets
      .map((target) => path.resolve(base, target))
      .filter((target) => {
        const rel = path.relative(boundary.dir, target);
        return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
      });
    if (owned.length > 0) {
      inside[key] = owned;
    }
  }
  return inside;
}

/**
 * A project holding exactly the package-owned sources, on an in-memory file
 * system at their real paths. Only the package's own aliases resolve — its
 * manifest entrypoints and the `paths` of its own tsconfig.json that point
 * inside it — so a self-import through the package name or a `~/` alias
 * works and every other workspace specifier stays unresolved by construction.
 */
export function createLocalProject(
  root: string,
  boundary: Boundary,
  files: string[],
  tsconfig?: string
): Project {
  const ownTsconfig = path.join(boundary.dir, "tsconfig.json");
  const project = new Project({
    compilerOptions: {
      baseUrl: root,
      jsx: ts.JsxEmit.ReactJSX,
      module: ts.ModuleKind.ESNext,
      moduleResolution: ts.ModuleResolutionKind.Bundler,
      paths: {
        ...packagePathAliases(boundary.dir),
        ...(fs.existsSync(ownTsconfig) &&
          tsconfigPathsInto(root, ownTsconfig, boundary)),
        ...(tsconfig !== undefined &&
          tsconfigPathsInto(root, tsconfig, boundary)),
      },
      skipLibCheck: true,
      strict: false,
      target: ts.ScriptTarget.ES2022,
    },
    skipFileDependencyResolution: true,
    useInMemoryFileSystem: true,
  });
  for (const file of files) {
    project.createSourceFile(file, fs.readFileSync(file, "utf8"));
  }
  return project;
}

function isSeedKind(
  kind: SymbolKind,
  seedKinds: ConceptSeedKind[]
): kind is ConceptSeedKind {
  return (seedKinds as string[]).includes(kind);
}

interface BindingOccurrences {
  /** `left.right` accesses (value or type position) per left identifier, per member. */
  members: Map<string, Map<string, number>>;
  /** Identifier spellings per name, skipping import and export declarations. */
  names: Map<string, number>;
  /** Wiring uses per name; only names with at least one. */
  uses: Map<string, PackageLocalBindingUses>;
}

/**
 * The wiring use of one identifier reference, read from its parent once a
 * member chain rooted at it is folded in. A member name (`obj.X`) is not a
 * reference of `X`.
 */
function bindingUseOf(node: Node): keyof PackageLocalBindingUses | undefined {
  let head: Node = node;
  let parent = head.getParent();
  if (
    parent !== undefined &&
    Node.isPropertyAccessExpression(parent) &&
    parent.getNameNode() === head
  ) {
    return undefined;
  }
  while (
    parent !== undefined &&
    Node.isPropertyAccessExpression(parent) &&
    parent.getExpression() === head
  ) {
    head = parent;
    parent = head.getParent();
  }
  if (parent === undefined) {
    return undefined;
  }
  if (Node.isNewExpression(parent)) {
    return parent.getExpression() === head ? "constructed" : "argument";
  }
  if (Node.isCallExpression(parent)) {
    return parent.getExpression() === head ? "called" : "argument";
  }
  if (Node.isPropertyAssignment(parent)) {
    return parent.getInitializer() === head ? "collected" : undefined;
  }
  if (
    Node.isShorthandPropertyAssignment(parent) ||
    Node.isArrayLiteralExpression(parent)
  ) {
    return "collected";
  }
  if (
    (Node.isJsxOpeningElement(parent) ||
      Node.isJsxSelfClosingElement(parent)) &&
    parent.getTagNameNode() === head
  ) {
    return "rendered";
  }
  return undefined;
}

function bindingOccurrences(file: SourceFile): BindingOccurrences {
  const names = new Map<string, number>();
  const members = new Map<string, Map<string, number>>();
  const uses = new Map<string, PackageLocalBindingUses>();
  const access = (left: Node, right: Node) => {
    if (!Node.isIdentifier(left)) {
      return;
    }
    const byMember = members.get(left.getText()) ?? new Map<string, number>();
    const member = right.getText();
    byMember.set(member, (byMember.get(member) ?? 0) + 1);
    members.set(left.getText(), byMember);
  };
  file.forEachDescendant((node, traversal) => {
    if (Node.isImportDeclaration(node) || Node.isExportDeclaration(node)) {
      traversal.skip();
      return;
    }
    if (Node.isIdentifier(node)) {
      const text = node.getText();
      names.set(text, (names.get(text) ?? 0) + 1);
      const use = bindingUseOf(node);
      if (use !== undefined) {
        const counts = uses.get(text) ?? {
          argument: 0,
          called: 0,
          collected: 0,
          constructed: 0,
          rendered: 0,
        };
        counts[use] += 1;
        uses.set(text, counts);
      }
    } else if (Node.isPropertyAccessExpression(node)) {
      access(node.getExpression(), node.getNameNode());
    } else if (Node.isQualifiedName(node)) {
      access(node.getLeft(), node.getRight());
    }
  });
  return { members, names, uses };
}

/**
 * Each module's `default` export resolved to an owned top-level declaration,
 * following ts-morph's alias resolution (`export default Foo`, `export { Foo
 * as default }`, `export { default } from`). Anonymous and expression
 * defaults yield an entry with no id.
 */
function collectDefaultExports(
  project: Project,
  boundary: Boundary,
  collected: CollectedSymbol[]
): PackageLocalDefaultExport[] {
  const idByNode = new Map(collected.map((symbol) => [symbol.node, symbol.id]));
  const defaults: PackageLocalDefaultExport[] = [];
  for (const file of project.getSourceFiles()) {
    const declarations = file.getExportedDeclarations().get("default");
    if (declarations === undefined) {
      continue;
    }
    const module = toPosix(path.relative(boundary.root, file.getFilePath()));
    const symbolId = declarations
      .map((declaration) => idByNode.get(declaration))
      .find((id) => id !== undefined);
    defaults.push({ module, ...(symbolId !== undefined && { symbolId }) });
  }
  return defaults.sort((a, b) => a.module.localeCompare(b.module));
}

/**
 * The V7 sweep's evidence folded per concept and module: only the package's
 * own files are in the project, so this is the part of each concept's
 * structural family that lives inside the package.
 */
function collectConceptParticipation(
  group: ConceptSeedGroup
): PackageLocalConceptParticipation[] {
  interface Entry {
    conceptId: string;
    counts: Map<ConceptRelationshipKind, number>;
    module: string;
    owners: Set<string>;
  }
  const entries = new Map<string, Entry>();
  for (const state of group.states) {
    for (const item of state.evidence) {
      if (item.kind === "declaration") {
        continue;
      }
      const key = `${state.seed.id}\n${item.file}`;
      const entry = entries.get(key) ?? {
        conceptId: state.seed.id,
        counts: new Map<ConceptRelationshipKind, number>(),
        module: item.file,
        owners: new Set<string>(),
      };
      entry.counts.set(item.kind, (entry.counts.get(item.kind) ?? 0) + 1);
      if (item.source !== undefined) {
        entry.owners.add(item.source.symbolId);
      }
      entries.set(key, entry);
    }
  }
  return [...entries.values()]
    .map<PackageLocalConceptParticipation>((entry) => ({
      conceptId: entry.conceptId,
      module: entry.module,
      relationships: Object.fromEntries(
        [...entry.counts.entries()].sort(([a], [b]) => a.localeCompare(b))
      ),
      symbols: [...entry.owners].sort(),
    }))
    .sort(
      (a, b) =>
        a.conceptId.localeCompare(b.conceptId) ||
        a.module.localeCompare(b.module)
    );
}

function unwrapExpression(node: Node): { inner: Node; asConst: boolean } {
  let inner = node;
  let asConst = false;
  for (;;) {
    if (Node.isParenthesizedExpression(inner)) {
      inner = inner.getExpression();
    } else if (
      Node.isAsExpression(inner) ||
      Node.isSatisfiesExpression(inner)
    ) {
      const typeNode = inner.getTypeNode();
      if (
        Node.isAsExpression(inner) &&
        typeNode !== undefined &&
        Node.isTypeReference(typeNode) &&
        typeNode.getText() === "const"
      ) {
        asConst = true;
      }
      inner = inner.getExpression();
    } else if (Node.isTypeAssertion(inner) || Node.isNonNullExpression(inner)) {
      inner = inner.getExpression();
    } else if (Node.isAwaitExpression(inner)) {
      inner = inner.getExpression();
    } else {
      return { asConst, inner };
    }
  }
}

function initializerOf(node: Node): PackageLocalInitializer {
  if (Node.isArrowFunction(node) || Node.isFunctionExpression(node)) {
    return "function";
  }
  if (Node.isClassExpression(node)) {
    return "class";
  }
  if (Node.isObjectLiteralExpression(node)) {
    return "object";
  }
  if (Node.isArrayLiteralExpression(node)) {
    return "array";
  }
  if (
    Node.isStringLiteral(node) ||
    Node.isNumericLiteral(node) ||
    Node.isBigIntLiteral(node) ||
    Node.isNoSubstitutionTemplateLiteral(node) ||
    Node.isTemplateExpression(node) ||
    Node.isRegularExpressionLiteral(node) ||
    node.getKind() === SyntaxKind.TrueKeyword ||
    node.getKind() === SyntaxKind.FalseKeyword ||
    node.getKind() === SyntaxKind.NullKeyword ||
    (Node.isPrefixUnaryExpression(node) &&
      Node.isNumericLiteral(node.getOperand()))
  ) {
    return "literal";
  }
  if (Node.isCallExpression(node) || Node.isTaggedTemplateExpression(node)) {
    return "call";
  }
  if (Node.isNewExpression(node)) {
    return "new";
  }
  if (Node.isIdentifier(node) || Node.isPropertyAccessExpression(node)) {
    return "reference";
  }
  return "other";
}

/** The leftmost identifier of a call or member chain. */
function rootIdentifier(node: Node): Node | undefined {
  let current: Node = node;
  for (;;) {
    if (Node.isIdentifier(current)) {
      return current;
    }
    if (
      Node.isCallExpression(current) ||
      Node.isTaggedTemplateExpression(current)
    ) {
      current = Node.isCallExpression(current)
        ? current.getExpression()
        : current.getTag();
    } else if (
      Node.isPropertyAccessExpression(current) ||
      Node.isElementAccessExpression(current)
    ) {
      current = current.getExpression();
    } else if (Node.isParenthesizedExpression(current)) {
      current = current.getExpression();
    } else {
      return undefined;
    }
  }
}

/** The leftmost identifier of a (possibly qualified) type name or `typeof` expression name. */
function leftmostName(node: Node): Node | undefined {
  let current: Node = node;
  while (Node.isQualifiedName(current)) {
    current = current.getLeft();
  }
  while (Node.isPropertyAccessExpression(current)) {
    current = current.getExpression();
  }
  return Node.isIdentifier(current) ? current : undefined;
}

const SCALAR_KEYWORDS = new Set([
  SyntaxKind.StringKeyword,
  SyntaxKind.NumberKeyword,
  SyntaxKind.BooleanKeyword,
  SyntaxKind.BigIntKeyword,
  SyntaxKind.SymbolKeyword,
]);

function aliasShapeOf(typeNode: Node | undefined): PackageLocalAliasShape {
  if (typeNode === undefined) {
    return "other";
  }
  if (SCALAR_KEYWORDS.has(typeNode.getKind())) {
    return "scalar";
  }
  if (Node.isIntersectionTypeNode(typeNode)) {
    const parts = typeNode.getTypeNodes();
    const scalar = parts.some((part) => SCALAR_KEYWORDS.has(part.getKind()));
    const object = parts.some(
      (part) => Node.isTypeLiteral(part) || Node.isTypeReference(part)
    );
    return scalar && object ? "brand" : "other";
  }
  if (Node.isUnionTypeNode(typeNode)) {
    return typeNode.getTypeNodes().every((part) => Node.isLiteralTypeNode(part))
      ? "literal-union"
      : "other";
  }
  if (Node.isTypeLiteral(typeNode)) {
    return "object";
  }
  if (Node.isTypeReference(typeNode)) {
    return "reference";
  }
  return "other";
}

function memberCounts(nodes: Node[]): { methods: number; properties: number } {
  let methods = 0;
  let properties = 0;
  for (const member of nodes) {
    if (
      Node.isMethodSignature(member) ||
      Node.isMethodDeclaration(member) ||
      Node.isCallSignatureDeclaration(member) ||
      Node.isConstructSignatureDeclaration(member)
    ) {
      methods += 1;
    } else if (Node.isPropertySignature(member)) {
      const type = member.getTypeNode();
      if (type !== undefined && Node.isFunctionTypeNode(type)) {
        methods += 1;
      } else {
        properties += 1;
      }
    } else if (Node.isPropertyDeclaration(member)) {
      const initializer = member.getInitializer();
      const type = member.getTypeNode();
      if (
        (initializer !== undefined &&
          (Node.isArrowFunction(initializer) ||
            Node.isFunctionExpression(initializer))) ||
        (type !== undefined && Node.isFunctionTypeNode(type))
      ) {
        methods += 1;
      } else {
        properties += 1;
      }
    } else if (
      Node.isGetAccessorDeclaration(member) ||
      Node.isSetAccessorDeclaration(member)
    ) {
      properties += 1;
    }
  }
  return { methods, properties };
}

/**
 * Each collected symbol's declaration shape plus its own V7 relationships to
 * local seeds. Local identities named by an annotation, a `typeof` query, or
 * a call's root are resolved through the checker; an external callee keeps
 * the import specifier that bound it.
 */
function collectDeclarations(
  collected: CollectedSymbol[],
  group: ConceptSeedGroup
): PackageLocalDeclaration[] {
  const idByNode = new Map(collected.map((symbol) => [symbol.node, symbol.id]));
  const resolveLocal = (identifier: Node | undefined): string | undefined => {
    if (identifier === undefined) {
      return undefined;
    }
    const symbol = identifier.getSymbol();
    if (symbol === undefined) {
      return undefined;
    }
    const target = symbol.getAliasedSymbol() ?? symbol;
    for (const declaration of target.getDeclarations()) {
      const id = idByNode.get(declaration);
      if (id !== undefined) {
        return id;
      }
    }
    return undefined;
  };
  const importSpecifiers = new Map<SourceFile, Map<string, string>>();
  const specifierOf = (file: SourceFile, localName: string) => {
    let bindings = importSpecifiers.get(file);
    if (bindings === undefined) {
      bindings = new Map<string, string>();
      for (const declaration of file.getImportDeclarations()) {
        const specifier = declaration.getModuleSpecifierValue();
        const names = [
          declaration.getDefaultImport()?.getText(),
          declaration.getNamespaceImport()?.getText(),
          ...declaration
            .getNamedImports()
            .map((named) => named.getAliasNode()?.getText() ?? named.getName()),
        ];
        for (const name of names) {
          if (name !== undefined) {
            bindings.set(name, specifier);
          }
        }
      }
      importSpecifiers.set(file, bindings);
    }
    return bindings.get(localName);
  };

  const conceptsBySymbol = new Map<
    string,
    Map<string, Map<ConceptRelationshipKind, number>>
  >();
  for (const state of group.states) {
    for (const item of state.evidence) {
      if (item.kind === "declaration" || item.source === undefined) {
        continue;
      }
      const bySeed =
        conceptsBySymbol.get(item.source.symbolId) ??
        new Map<string, Map<ConceptRelationshipKind, number>>();
      const counts =
        bySeed.get(state.seed.id) ?? new Map<ConceptRelationshipKind, number>();
      counts.set(item.kind, (counts.get(item.kind) ?? 0) + 1);
      bySeed.set(state.seed.id, counts);
      conceptsBySymbol.set(item.source.symbolId, bySeed);
    }
  }

  return collected.map<PackageLocalDeclaration>((symbol) => {
    const node = symbol.node;
    const declaration: PackageLocalDeclaration = {
      concepts: [],
      symbolId: symbol.id,
    };
    const containsJsx = (body: Node) =>
      body.getFirstDescendant(
        (descendant) =>
          Node.isJsxElement(descendant) ||
          Node.isJsxSelfClosingElement(descendant) ||
          Node.isJsxFragment(descendant)
      ) !== undefined;
    if (Node.isFunctionDeclaration(node)) {
      if (containsJsx(node)) {
        declaration.jsx = true;
      }
    } else if (Node.isVariableDeclaration(node)) {
      const initializer = node.getInitializer();
      if (initializer === undefined) {
        declaration.initializer = "none";
      } else {
        const { inner, asConst } = unwrapExpression(initializer);
        declaration.initializer = initializerOf(inner);
        if (asConst) {
          declaration.asConst = true;
        }
        if (declaration.initializer === "function" && containsJsx(inner)) {
          declaration.jsx = true;
        }
        if (declaration.initializer === "call") {
          const root = rootIdentifier(inner);
          if (root !== undefined) {
            const name = root.getText();
            const specifier = specifierOf(node.getSourceFile(), name);
            const symbolId = resolveLocal(root);
            declaration.callee = {
              name,
              ...(specifier !== undefined &&
                symbolId === undefined && { specifier }),
              ...(symbolId !== undefined && { symbolId }),
            };
          }
        }
      }
      const typeNode = node.getTypeNode();
      if (typeNode !== undefined && Node.isTypeReference(typeNode)) {
        const annotation = resolveLocal(leftmostName(typeNode.getTypeName()));
        if (annotation !== undefined) {
          declaration.annotation = annotation;
        }
      }
    } else if (Node.isTypeAliasDeclaration(node)) {
      const typeNode = node.getTypeNode();
      declaration.aliasShape = aliasShapeOf(typeNode);
      if (typeNode !== undefined && Node.isTypeLiteral(typeNode)) {
        declaration.members = memberCounts(typeNode.getMembers());
      }
      const queries = new Set<string>();
      for (const query of node.getDescendantsOfKind(SyntaxKind.TypeQuery)) {
        const id = resolveLocal(leftmostName(query.getExprName()));
        if (id !== undefined) {
          queries.add(id);
        }
      }
      if (queries.size > 0) {
        declaration.typeQueries = [...queries].sort();
      }
    } else if (Node.isInterfaceDeclaration(node)) {
      declaration.members = memberCounts(node.getMembers());
    } else if (Node.isClassDeclaration(node)) {
      declaration.members = memberCounts(node.getMembers());
      if (node.isAbstract()) {
        declaration.abstract = true;
      }
    }
    const bySeed = conceptsBySymbol.get(symbol.id);
    if (bySeed !== undefined) {
      declaration.concepts = [...bySeed.entries()]
        .map(([conceptId, counts]) => ({
          conceptId,
          relationships: Object.fromEntries(
            [...counts.entries()].sort(([a], [b]) => a.localeCompare(b))
          ),
        }))
        .sort((a, b) => a.conceptId.localeCompare(b.conceptId));
    }
    return declaration;
  });
}

function collectImports(
  project: Project,
  boundary: Boundary
): PackageLocalImport[] {
  const sites: PackageLocalImport[] = [];
  const relative = (absolute: string) =>
    toPosix(path.relative(boundary.root, absolute));
  for (const file of project.getSourceFiles()) {
    const sourceModule = relative(file.getFilePath());
    const occurrences = bindingOccurrences(file);
    const resolution = (target: SourceFile | undefined) =>
      target === undefined
        ? ({ scope: "external" } as const)
        : ({
            scope: "internal",
            targetModule: relative(target.getFilePath()),
          } as const);
    for (const declaration of file.getImportDeclarations()) {
      const specifier = declaration.getModuleSpecifierValue();
      const typeOnly = declaration.isTypeOnly();
      const base = {
        sourceModule,
        specifier,
        ...resolution(declaration.getModuleSpecifierSourceFile()),
      };
      const bound = (localName: string) => ({
        bindingOccurrences: occurrences.names.get(localName) ?? 0,
        localName,
      });
      const usesOf = (localName: string, siteTypeOnly: boolean) => {
        const uses = occurrences.uses.get(localName);
        return base.scope === "internal" && !siteTypeOnly && uses !== undefined
          ? { uses }
          : {};
      };
      const membersOf = (localName: string) => {
        const accessed = occurrences.members.get(localName);
        if (accessed === undefined) {
          return {};
        }
        const members = [...accessed.entries()]
          .map(([name, count]) => ({ name, occurrences: count }))
          .sort((a, b) => a.name.localeCompare(b.name));
        return { members };
      };
      const defaultImport = declaration.getDefaultImport();
      const namespaceImport = declaration.getNamespaceImport();
      const named = declaration.getNamedImports();
      if (defaultImport !== undefined) {
        sites.push({
          ...base,
          importedName: "default",
          kind: "default",
          ...bound(defaultImport.getText()),
          typeOnly,
          ...usesOf(defaultImport.getText(), typeOnly),
        });
      }
      if (namespaceImport !== undefined) {
        sites.push({
          ...base,
          kind: "namespace",
          ...bound(namespaceImport.getText()),
          ...membersOf(namespaceImport.getText()),
          typeOnly,
        });
      }
      for (const specifierNode of named) {
        const siteTypeOnly = typeOnly || specifierNode.isTypeOnly();
        const localName =
          specifierNode.getAliasNode()?.getText() ?? specifierNode.getName();
        sites.push({
          ...base,
          importedName: specifierNode.getName(),
          kind: siteTypeOnly ? "type" : "named",
          ...bound(localName),
          typeOnly: siteTypeOnly,
          ...usesOf(localName, siteTypeOnly),
        });
      }
      if (
        defaultImport === undefined &&
        namespaceImport === undefined &&
        named.length === 0
      ) {
        sites.push({ ...base, kind: "side-effect", typeOnly: false });
      }
    }
    for (const declaration of file.getExportDeclarations()) {
      const specifier = declaration.getModuleSpecifierValue();
      if (specifier === undefined) {
        continue;
      }
      const typeOnly = declaration.isTypeOnly();
      const base = {
        sourceModule,
        specifier,
        ...resolution(declaration.getModuleSpecifierSourceFile()),
      };
      const named = declaration.getNamedExports();
      if (named.length === 0) {
        sites.push({ ...base, kind: "star-re-export", typeOnly });
        continue;
      }
      for (const specifierNode of named) {
        sites.push({
          ...base,
          importedName: specifierNode.getName(),
          kind: "re-export",
          localName:
            specifierNode.getAliasNode()?.getText() ?? specifierNode.getName(),
          typeOnly: typeOnly || specifierNode.isTypeOnly(),
        });
      }
    }
  }
  return sites.sort(
    (a, b) =>
      a.sourceModule.localeCompare(b.sourceModule) ||
      a.specifier.localeCompare(b.specifier) ||
      a.kind.localeCompare(b.kind) ||
      (a.importedName ?? "").localeCompare(b.importedName ?? "") ||
      (a.localName ?? "").localeCompare(b.localName ?? "")
  );
}

function ratio(numerator: number, denominator: number): number {
  return denominator === 0 ? 0 : numerator / denominator;
}

export function analyzePackageLocal(
  options: AnalyzePackageLocalOptions
): PackageLocalReport {
  const root = fs.realpathSync(
    options.root ? path.resolve(options.root) : findRepoRoot(process.cwd())
  );
  const config = options.config ?? ANALYSIS_CONFIG;
  const boundary = resolveBoundary(root, options.target);
  const files = packageSourceFiles(root, boundary);
  const project = createLocalProject(root, boundary, files, options.tsconfig);

  const collected = collectSymbols(project, boundary);
  const publicNodes = packagePublicNodes(project, boundary);
  const symbols: PackageLocalSymbol[] = collected
    .map((symbol) => ({
      declarationFile: symbol.declarationFile,
      exported: symbol.exported,
      id: symbol.id,
      kind: symbol.kind,
      name: symbol.name,
      packagePublic:
        symbol.exported &&
        (publicNodes === null || publicNodes.has(symbol.node)),
      startLine: symbol.startLine,
    }))
    .sort(
      (a, b) =>
        a.declarationFile.localeCompare(b.declarationFile) ||
        a.startLine - b.startLine ||
        a.name.localeCompare(b.name)
    );
  const surfaceById = new Map(symbols.map((symbol) => [symbol.id, symbol]));
  const localComplexity = analyzeLocalComplexity(
    project,
    boundary,
    collected.flatMap((symbol) => {
      const surface = surfaceById.get(symbol.id);
      return surface === undefined
        ? []
        : [
            {
              exported: surface.exported,
              node: symbol.node,
              packagePublic: surface.packagePublic,
              symbolId: symbol.id,
            },
          ];
    }),
    config
  );

  const seenSeeds = new Set<string>();
  const conceptSeeds: PackageLocalConceptSeed[] = [];
  for (const symbol of collected) {
    if (!isSeedKind(symbol.kind, config.concepts.seedKinds)) {
      continue;
    }
    if (seenSeeds.has(symbol.id)) {
      continue;
    }
    seenSeeds.add(symbol.id);
    conceptSeeds.push({
      file: symbol.declarationFile,
      id: symbol.id,
      kind: symbol.kind,
      name: symbol.name,
    });
  }
  conceptSeeds.sort((a, b) => a.id.localeCompare(b.id));
  const seedGroup = prepareConceptSeeds(
    { boundary, surface: [], symbols: collected },
    config
  );
  sweepConceptEvidence(project, root, [seedGroup]);
  const declarationById = new Map(
    collectDeclarations(collected, seedGroup).map((declaration) => [
      declaration.symbolId,
      declaration,
    ])
  );

  const exported = symbols.filter((symbol) => symbol.exported).length;
  const packagePublic = symbols.filter((symbol) => symbol.packagePublic).length;
  const anchor = anchorFor(boundary, config);
  const roles = collectModuleRoles(project, boundary);

  return {
    package: {
      ...(boundary.packageName !== undefined && { name: boundary.packageName }),
      boundaryType: boundary.type,
      entrypoints: boundaryEntrypoints(boundary),
      explicitlyPublishable: boundary.explicitlyPublishable,
      exportSubpaths:
        boundary.exportSubpaths === null
          ? null
          : [...boundary.exportSubpaths].sort(),
      path: boundary.relPath,
    },
    policyVersion: ANALYSIS_POLICY_VERSION,
    schemaVersion: PACKAGE_LOCAL_REPORT_SCHEMA_VERSION,
    ...(anchor !== undefined && {
      anchor: {
        target: anchor.target,
        ...(anchor.reason !== undefined && { reason: anchor.reason }),
      },
    }),
    conceptParticipation: collectConceptParticipation(seedGroup),
    conceptSeeds,
    declarations: symbols.flatMap((symbol) => {
      const declaration = declarationById.get(symbol.id);
      return declaration === undefined ? [] : [declaration];
    }),
    defaultExports: collectDefaultExports(project, boundary, collected),
    imports: collectImports(project, boundary),
    localComplexity,
    moduleRoles: Object.fromEntries(
      [...roles.entries()].sort(([a], [b]) => a.localeCompare(b))
    ),
    sources: files.map((file) => {
      const rel = toPosix(path.relative(root, file));
      return { kind: classifyFile(rel), path: rel };
    }),
    summary: {
      declaredSurfaceRatio: ratio(packagePublic, symbols.length),
      moduleExportedSymbols: exported,
      moduleOnlyExports: exported - packagePublic,
      packagePublicSymbols: packagePublic,
      totalSymbols: symbols.length,
    },
    symbols,
  };
}
