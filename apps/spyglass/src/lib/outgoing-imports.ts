import type { Node, Project, SourceFile } from "ts-morph";
import { isAbsolute, relative as pathRelative } from "#path";

import type { Boundary, SourceOwner } from "./boundary-model";

import { boundaryContains, toPosix } from "./boundary-model";

export interface OutgoingImportSite {
  declarationModule: string;

  package: string;

  sourceModule: string;

  symbolKey: string;
  symbolName: string;

  typeDeclaration: boolean;

  typeOnly: boolean;
}

export function collectOutgoingImports(
  project: Project,
  boundary: Boundary,
  ownerOf: SourceOwner
): OutgoingImportSite[] {
  const sites: OutgoingImportSite[] = [];
  const relative = (absolute: string) =>
    toPosix(pathRelative(boundary.root, absolute));
  const external = (file: SourceFile | undefined): SourceFile | undefined => {
    if (file === undefined) {
      return undefined;
    }
    const filePath = file.getFilePath();
    if (boundaryContains(boundary, filePath)) {
      return undefined;
    }
    if (filePath.includes("/node_modules/")) {
      return undefined;
    }
    const rel = pathRelative(boundary.root, filePath);
    if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) {
      return undefined;
    }
    return file;
  };

  const push = (
    file: SourceFile,
    imported: SourceFile,
    nameNode: Node,
    name: string,
    typeOnly: boolean
  ) => {
    const target = nameNode.getSymbol()?.getAliasedSymbol();
    const declarations = target?.getDeclarations() ?? [];
    const declaring = declarations[0]?.getSourceFile();
    const declarationModule = relative((declaring ?? imported).getFilePath());
    const symbolName = target?.getName() ?? name;
    sites.push({
      declarationModule,
      package: ownerOf(imported.getFilePath()),
      sourceModule: relative(file.getFilePath()),
      symbolKey: `${declarationModule}#${symbolName}`,
      symbolName,
      typeDeclaration:
        declarations.length > 0 &&
        declarations.every(
          (declaration) =>
            declaration.getKindName() === "InterfaceDeclaration" ||
            declaration.getKindName() === "TypeAliasDeclaration"
        ),
      typeOnly,
    });
  };

  for (const file of project.getSourceFiles()) {
    if (!boundaryContains(boundary, file.getFilePath())) {
      continue;
    }
    collectOutgoingImportsDeclaration(file, external, push);
    for (const declaration of file.getExportDeclarations()) {
      const imported = external(declaration.getModuleSpecifierSourceFile());
      if (imported === undefined) {
        continue;
      }
      const declarationTypeOnly = declaration.isTypeOnly();
      for (const specifier of declaration.getNamedExports()) {
        push(
          file,
          imported,
          specifier.getNameNode(),
          specifier.getName(),
          declarationTypeOnly || specifier.isTypeOnly()
        );
      }
    }
  }
  return sites.sort(
    (a, b) =>
      a.sourceModule.localeCompare(b.sourceModule) ||
      a.symbolKey.localeCompare(b.symbolKey)
  );
}

function collectOutgoingImportsDeclaration(
  file: SourceFile,
  external: (file: SourceFile | undefined) => SourceFile | undefined,
  push: (
    file: SourceFile,
    imported: SourceFile,
    nameNode: Node,
    name: string,
    typeOnly: boolean
  ) => void
) {
  for (const declaration of file.getImportDeclarations()) {
    const imported = external(declaration.getModuleSpecifierSourceFile());
    if (imported === undefined) {
      continue;
    }
    const declarationTypeOnly = declaration.isTypeOnly();
    const defaultImport = declaration.getDefaultImport();
    if (defaultImport !== undefined) {
      push(file, imported, defaultImport, "default", declarationTypeOnly);
    }
    for (const specifier of declaration.getNamedImports()) {
      push(
        file,
        imported,
        specifier.getNameNode(),
        specifier.getName(),
        declarationTypeOnly || specifier.isTypeOnly()
      );
    }
  }
}
