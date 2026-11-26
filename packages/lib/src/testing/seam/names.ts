import { existsSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import ts from "typescript";
import { packageDirectories } from "./manifest";
import { parseSourceFile, sourceFiles } from "./scan";

const DECLARATION_FILE_PATTERN = /\.d\.[cm]?ts$/;

const FORBIDDEN_EXPORT_NAMES: readonly {
  readonly pattern: RegExp;
  readonly reason: string;
}[] = [
  { pattern: /Manager$/, reason: "*Manager is reserved for apps/*" },
  {
    pattern: /(?<!File)System$/,
    reason: "*System obscures depth (only *FileSystem is allowed)",
  },
  { pattern: /InMemory/, reason: "name in-memory adapters Memory*" },
];

const NON_PUBLIC_SOURCE_DIRS = ["node_modules", "test", "testing"];

function hasExportModifier(node: ts.Node): boolean {
  return (
    ts.canHaveModifiers(node) &&
    (ts.getModifiers(node) ?? []).some(
      (modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword
    )
  );
}

function bindingNames(name: ts.BindingName): string[] {
  if (ts.isIdentifier(name)) {
    return [name.text];
  }
  return name.elements.flatMap((element) =>
    ts.isBindingElement(element) ? bindingNames(element.name) : []
  );
}

function exportDeclarationNames(statement: ts.ExportDeclaration): string[] {
  const { exportClause } = statement;
  if (exportClause && ts.isNamedExports(exportClause)) {
    return exportClause.elements.map((element) => element.name.text);
  }
  return exportClause && ts.isNamespaceExport(exportClause)
    ? [exportClause.name.text]
    : [];
}

function exportedDeclarationNames(statement: ts.Statement): string[] {
  if (ts.isVariableStatement(statement)) {
    return statement.declarationList.declarations.flatMap((declaration) =>
      bindingNames(declaration.name)
    );
  }
  if (
    ts.isClassDeclaration(statement) ||
    ts.isFunctionDeclaration(statement) ||
    ts.isInterfaceDeclaration(statement) ||
    ts.isTypeAliasDeclaration(statement) ||
    ts.isEnumDeclaration(statement)
  ) {
    return statement.name ? [statement.name.text] : [];
  }
  return [];
}

function exportedNames(sourceFile: ts.SourceFile): string[] {
  return sourceFile.statements.flatMap((statement) => {
    if (ts.isExportDeclaration(statement)) {
      return exportDeclarationNames(statement);
    }
    return hasExportModifier(statement)
      ? exportedDeclarationNames(statement)
      : [];
  });
}

export function auditExportNames(packagesDir: string): string[] {
  const root = resolve(packagesDir);
  const violations: string[] = [];
  for (const dir of packageDirectories(root)) {
    const srcDir = join(dir, "src");
    if (!existsSync(srcDir)) {
      continue;
    }
    const files = sourceFiles(srcDir, {
      skipDirs: NON_PUBLIC_SOURCE_DIRS,
    }).filter((path) => !DECLARATION_FILE_PATTERN.test(path));
    for (const file of files) {
      for (const name of exportedNames(parseSourceFile(file))) {
        for (const { pattern, reason } of FORBIDDEN_EXPORT_NAMES) {
          if (pattern.test(name)) {
            const label = relative(root, file).replaceAll("\\", "/");
            violations.push(`${label}: exported name "${name}": ${reason}`);
          }
        }
      }
    }
  }
  return violations;
}

export function assertExportNames(packagesDir: string): void {
  const violations = auditExportNames(packagesDir);
  if (violations.length > 0) {
    throw new Error(`Export naming violations:\n- ${violations.join("\n- ")}`);
  }
}
