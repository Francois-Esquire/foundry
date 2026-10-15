import { relative, resolve } from "node:path";
import type { Project } from "ts-morph";
import type { InternalizeSymbolPlan, SurfaceReport } from "./types";

interface SourceSite {
  module: string;
  names: string[];
  package: string;
  specifier?: string;
}
interface ImportSite extends SourceSite {
  importKind: "named" | "type";
  runtime: boolean;
  specifier: string;
}
interface ExportSite extends SourceSite {
  exportForm: "named-export" | "named-reexport" | "type-reexport";
}

/** Source operations produced by the internalize compiler, before architectural projection. */
export type InternalizeOperation = {
  file: string;
  symbolId: string;
} & (
  | {
      kind: "rewrite-import";
      form:
        | "named-import-relative"
        | "type-import-relative"
        | "named-import"
        | "type-import";
      before: ImportSite;
      after: ImportSite;
    }
  | {
      kind: "remove-export" | "rewrite-reexport";
      form: ExportSite["exportForm"];
      before: ExportSite;
      after: SourceSite;
    }
);

/** Describes the compiler's actual import destinations and removed exposures. Chooses no new edits. */
export function internalizeOperations(
  source: Project,
  edited: Project,
  root: string,
  plan: InternalizeSymbolPlan,
  report: SurfaceReport
): InternalizeOperation[] {
  const symbol = report.symbols.find((entry) => entry.id === plan.subject.id);
  if (symbol === undefined) {
    throw new Error(`Missing compiled symbol ${plan.subject.id}`);
  }
  const operations: InternalizeOperation[] = [];
  const packageId = plan.target.package;
  const importers = new Set(
    plan.plannedChanges
      .filter((change) => change.kind === "rewrite-import")
      .map((change) => change.file)
  );
  for (const file of importers) {
    const original = source.getSourceFileOrThrow(resolve(root, file));
    const changed = edited.getSourceFileOrThrow(resolve(root, file));
    for (const declaration of original.getImportDeclarations()) {
      const target = declaration.getModuleSpecifierSourceFile();
      if (target === undefined) {
        continue;
      }
      const exposed = new Set(
        plan.publicRoutes
          .filter((route) => resolve(root, route.file) === target.getFilePath())
          .map((route) => route.exportedName)
      );
      const selected = declaration
        .getNamedImports()
        .filter((binding) => exposed.has(binding.getName()));
      if (selected.length === 0) {
        continue;
      }
      const aliases = selected.map(
        (binding) => binding.getAliasNode()?.getText() ?? binding.getName()
      );
      const destination = changed
        .getImportDeclarations()
        .find(
          (candidate) =>
            candidate.getModuleSpecifierSourceFile()?.getFilePath() ===
              resolve(root, symbol.declarationFile) &&
            aliases.every((alias) =>
              candidate
                .getNamedImports()
                .some(
                  (binding) =>
                    (binding.getAliasNode()?.getText() ?? binding.getName()) ===
                    alias
                )
            )
        );
      if (destination === undefined) {
        throw new Error(`No compiled import destination in ${file}`);
      }
      const specifier = declaration.getModuleSpecifierValue();
      const typeOnly =
        declaration.isTypeOnly() ||
        selected.every((binding) => binding.isTypeOnly());
      const importKind = typeOnly ? "type" : "named";
      const relativeImport = specifier.startsWith(".");
      const form = importForm(typeOnly, relativeImport);
      operations.push({
        after: {
          importKind,
          module: symbol.declarationFile,
          names: [symbol.name],
          package: packageId,
          runtime: !typeOnly,
          specifier: destination.getModuleSpecifierValue(),
        },
        before: {
          importKind,
          module: relative(root, target.getFilePath()).replaceAll("\\", "/"),
          names: [
            ...new Set(selected.map((binding) => binding.getName())),
          ].sort(),
          package: packageId,
          runtime: !typeOnly,
          specifier,
        },
        file,
        form,
        kind: "rewrite-import",
        symbolId: symbol.id,
      });
    }
  }
  operations.push(...describeRemovedExposures(source, root, plan));
  return operations;
}

function importForm(
  typeOnly: boolean,
  relativeImport: boolean
): Extract<InternalizeOperation, { kind: "rewrite-import" }>["form"] {
  if (typeOnly) {
    return relativeImport ? "type-import-relative" : "type-import";
  }
  return relativeImport ? "named-import-relative" : "named-import";
}
function exportForm(
  kind: InternalizeSymbolPlan["publicRoutes"][number]["kind"]
): "named-reexport" | "type-reexport" {
  return kind === "type-export" ? "type-reexport" : "named-reexport";
}

function describeRemovedExposures(
  source: Project,
  root: string,
  plan: InternalizeSymbolPlan
): InternalizeOperation[] {
  const operations: InternalizeOperation[] = [];
  const packageId = plan.target.package;
  for (const route of plan.publicRoutes) {
    const statement = source
      .getSourceFileOrThrow(resolve(root, route.file))
      .getExportDeclarations()
      .find((declaration) =>
        declaration
          .getNamedExports()
          .some(
            (binding) =>
              (binding.getAliasNode()?.getText() ?? binding.getName()) ===
              route.exportedName
          )
      );
    const form =
      route.statement === undefined ? "named-export" : exportForm(route.kind);
    const specifier = statement?.getModuleSpecifierValue();
    operations.push({
      after: { module: route.file, names: [], package: packageId },
      before: {
        exportForm: form,
        module: route.file,
        names: [route.exportedName],
        package: packageId,
        ...(specifier !== undefined && { specifier }),
      },
      file: route.file,
      form,
      kind:
        route.statement === undefined ? "remove-export" : "rewrite-reexport",
      symbolId: plan.subject.id,
    });
  }
  return operations;
}
