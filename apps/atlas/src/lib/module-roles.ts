import * as path from "node:path";
import type { Project, SourceFile } from "ts-morph";

import { Node } from "ts-morph";

import type { Boundary } from "./boundary";
import { boundaryContains, boundaryEntrypoints, toPosix } from "./boundary";
import type { ModuleRole } from "./types";

// Module roles: is a file an aggregator (it mostly forwards other modules'
// exports) or an internal module with declarations of its own? Purely
// syntactic — statement kinds and local names only, no symbol resolution —
// so it costs one pass over statements per file and never depends on the
// file's name.

function isDeclaration(statement: Node): boolean {
  return (
    Node.isFunctionDeclaration(statement) ||
    Node.isClassDeclaration(statement) ||
    Node.isVariableStatement(statement) ||
    Node.isInterfaceDeclaration(statement) ||
    Node.isTypeAliasDeclaration(statement) ||
    Node.isEnumDeclaration(statement) ||
    Node.isModuleDeclaration(statement) ||
    Node.isExportAssignment(statement)
  );
}

function importedNames(file: SourceFile): Set<string> {
  const names = new Set<string>();
  for (const declaration of file.getImportDeclarations()) {
    const defaultImport = declaration.getDefaultImport();
    if (defaultImport !== undefined) {
      names.add(defaultImport.getText());
    }
    const namespaceImport = declaration.getNamespaceImport();
    if (namespaceImport !== undefined) {
      names.add(namespaceImport.getText());
    }
    for (const named of declaration.getNamedImports()) {
      names.add(named.getAliasNode()?.getText() ?? named.getName());
    }
  }
  return names;
}

/**
 * `export { Foo }` forwards when every listed local name was imported;
 * with a module specifier it is a re-export by construction.
 */
export function roleOf(file: SourceFile, entrypoint: boolean): ModuleRole {
  const imported = importedNames(file);
  let reExports = 0;
  let ownDeclarations = 0;
  for (const statement of file.getStatements()) {
    if (Node.isExportDeclaration(statement)) {
      if (statement.getModuleSpecifier() !== undefined) {
        reExports += 1;
        continue;
      }
      const named = statement.getNamedExports();
      if (
        named.length > 0 &&
        named.every((item) => imported.has(item.getName()))
      ) {
        reExports += 1;
      }
    } else if (isDeclaration(statement)) {
      ownDeclarations += 1;
    }
  }
  return {
    entrypoint,
    kind:
      reExports > 0 && reExports >= ownDeclarations ? "aggregator" : "internal",
    ownDeclarations,
    reExports,
  };
}

/** Role of every boundary source file, keyed by root-relative posix path. */
export function collectModuleRoles(
  project: Project,
  boundary: Boundary
): Map<string, ModuleRole> {
  const entrypoints = new Set(
    boundaryEntrypoints(boundary).map((entry) => entry.file)
  );
  const roles = new Map<string, ModuleRole>();
  for (const file of project.getSourceFiles()) {
    const absolute = file.getFilePath();
    if (!boundaryContains(boundary, absolute)) {
      continue;
    }
    const relative = toPosix(path.relative(boundary.root, absolute));
    roles.set(relative, roleOf(file, entrypoints.has(relative)));
  }
  return roles;
}
