import type { Project, SourceFile } from "ts-morph";
import { Node } from "ts-morph";
import { relative as pathRelative } from "#path";
import type { Boundary, BoundaryEntrypoint } from "./boundary-model";
import { boundaryContains, toPosix } from "./boundary-model";
import type { ModuleRole } from "./types";

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

export function collectModuleRoles(
  project: Project,
  boundary: Boundary,
  declared: readonly BoundaryEntrypoint[]
): Map<string, ModuleRole> {
  const entrypoints = new Set(declared.map((entry) => entry.file));
  const roles = new Map<string, ModuleRole>();
  for (const file of project.getSourceFiles()) {
    const absolute = file.getFilePath();
    if (!boundaryContains(boundary, absolute)) {
      continue;
    }
    const relative = toPosix(pathRelative(boundary.root, absolute));
    roles.set(relative, roleOf(file, entrypoints.has(relative)));
  }
  return roles;
}
