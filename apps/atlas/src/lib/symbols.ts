import * as path from "node:path";
import type { Project, SourceFile } from "ts-morph";

import { Node, SyntaxKind } from "ts-morph";

import type { Boundary } from "./boundary";
import { boundaryContains, toPosix } from "./boundary";
import type { SymbolKind } from "./types";

export interface CollectedSymbol {
  declarationFile: string;
  exported: boolean;
  id: string;
  kind: SymbolKind;
  name: string;
  node: Node;
  startLine: number;
}

export function kindOf(node: Node): SymbolKind {
  if (Node.isFunctionDeclaration(node)) {
    return "function";
  }
  if (Node.isClassDeclaration(node)) {
    return "class";
  }
  if (Node.isInterfaceDeclaration(node)) {
    return "interface";
  }
  if (Node.isTypeAliasDeclaration(node)) {
    return "type";
  }
  if (Node.isEnumDeclaration(node)) {
    return "enum";
  }
  if (Node.isVariableDeclaration(node)) {
    return "variable";
  }
  if (Node.isModuleDeclaration(node)) {
    return "namespace";
  }
  return "other";
}

export function topLevelDeclarations(file: SourceFile): Node[] {
  const declarations: Node[] = [];
  for (const statement of file.getStatements()) {
    if (
      Node.isFunctionDeclaration(statement) ||
      Node.isClassDeclaration(statement) ||
      Node.isInterfaceDeclaration(statement) ||
      Node.isTypeAliasDeclaration(statement) ||
      Node.isEnumDeclaration(statement) ||
      Node.isModuleDeclaration(statement)
    ) {
      declarations.push(statement);
    } else if (Node.isVariableStatement(statement)) {
      for (const declaration of statement.getDeclarations()) {
        if (Node.isIdentifier(declaration.getNameNode())) {
          declarations.push(declaration);
        }
      }
    }
  }
  return declarations;
}

function hasExportModifier(node: Node): boolean {
  const holder = Node.isVariableDeclaration(node)
    ? node.getFirstAncestorByKind(SyntaxKind.VariableStatement)
    : node;
  return (
    holder !== undefined &&
    Node.isModifierable(holder) &&
    holder.getModifiers().some((m) => m.getKind() === SyntaxKind.ExportKeyword)
  );
}

function nameOf(node: Node): string | undefined {
  if (Node.hasName(node)) {
    return node.getName();
  }
  return undefined;
}

/**
 * Collect the named top-level declarations owned by the boundary.
 * A declaration is `exported` when any boundary module exposes it, directly
 * or through a re-export/barrel — re-export aliases resolve back to the
 * original declaration, so a barreled symbol is counted once.
 */
export function collectSymbols(
  project: Project,
  boundary: Boundary
): CollectedSymbol[] {
  const files = project
    .getSourceFiles()
    .filter(
      (file) =>
        boundaryContains(boundary, file.getFilePath()) &&
        !file.isDeclarationFile()
    );

  const exportedDeclarations = new Set<Node>();
  for (const file of files) {
    for (const declarations of file.getExportedDeclarations().values()) {
      for (const declaration of declarations) {
        exportedDeclarations.add(declaration);
      }
    }
  }

  const collected: CollectedSymbol[] = [];
  const seen = new Set<string>();
  for (const file of files) {
    const relFile = toPosix(path.relative(boundary.root, file.getFilePath()));
    for (const declaration of topLevelDeclarations(file)) {
      const name = nameOf(declaration);
      if (name === undefined) {
        continue;
      }
      const kind = kindOf(declaration);
      const key = `${relFile}#${kind}#${name}`;
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      collected.push({
        declarationFile: relFile,
        exported:
          exportedDeclarations.has(declaration) ||
          hasExportModifier(declaration),
        id: `${relFile}#${name}`,
        kind,
        name,
        node: declaration,
        startLine: declaration.getStartLineNumber(),
      });
    }
  }
  return collected;
}
