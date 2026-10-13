import { resolve } from "node:path";
import type {
  ImportDeclaration,
  ImportSpecifierStructure,
  OptionalKind,
  Project,
  SourceFile,
} from "ts-morph";
import { importSpecifierFor } from "./import-specifier";
import type {
  InternalizeSymbolPlan,
  MutationEdit,
  PlanBlocker,
  SurfaceReport,
} from "./types";

interface ImportEdits {
  edits: MutationEdit[];
  files: Map<string, SourceFile>;
}

/** Repoint the saved plan's internal named imports before its entrypoint exports go. */
export function editInternalImports(
  project: Project,
  root: string,
  plan: InternalizeSymbolPlan,
  report: SurfaceReport
): ImportEdits | { blocker: PlanBlocker } {
  const files = new Map<string, SourceFile>();
  const edits: MutationEdit[] = [];
  const symbol = report.symbols.find(
    (candidate) => candidate.id === plan.subject.id
  );
  const target =
    symbol && project.getSourceFile(resolve(root, symbol.declarationFile));
  const importers = new Set(
    plan.plannedChanges
      .filter((change) => change.kind === "rewrite-import")
      .map((change) => change.file)
  );
  for (const relative of importers) {
    const importer = project.getSourceFile(resolve(root, relative));
    if (
      importer === undefined ||
      target === undefined ||
      symbol === undefined
    ) {
      return {
        blocker: {
          detail: `Cannot resolve the importer or declaration for ${relative}.`,
          reason: "apply-unsupported",
        },
      };
    }
    const edited = repointFile(importer, target, plan, root, symbol.name);
    if (edited === undefined) {
      return {
        blocker: {
          detail: `No named import of ${plan.subject.name} through its planned entrypoints found in ${relative}.`,
          reason: "apply-unsupported",
        },
      };
    }
    edits.push({ ...edited, file: relative });
    files.set(relative, importer);
  }
  return { edits, files };
}

function repointFile(
  importer: SourceFile,
  target: SourceFile,
  plan: InternalizeSymbolPlan,
  root: string,
  name: string
): Omit<MutationEdit, "file"> | undefined {
  const before = new Map<ImportDeclaration, string>();
  const after = new Set<ImportDeclaration>();
  for (const declaration of importer.getImportDeclarations()) {
    const route = plan.publicRoutes.filter(
      (candidate) =>
        declaration.getModuleSpecifierSourceFile()?.getFilePath() ===
        resolve(root, candidate.file)
    );
    const exposed = new Set(route.map((candidate) => candidate.exportedName));
    const moved = declaration
      .getNamedImports()
      .filter((specifier) => exposed.has(specifier.getName()));
    if (moved.length === 0) {
      continue;
    }
    before.set(declaration, declaration.getText());
    const bindings: OptionalKind<ImportSpecifierStructure>[] = moved.map(
      (specifier) => {
        const local =
          specifier.getAliasNode()?.getText() ?? specifier.getName();
        return {
          name,
          ...(local !== name && { alias: local }),
          isTypeOnly: declaration.isTypeOnly() || specifier.isTypeOnly(),
        };
      }
    );
    const typeOnly = bindings.every((binding) => binding.isTypeOnly);
    const destination = importer
      .getImportDeclarations()
      .find(
        (candidate) =>
          candidate !== declaration &&
          candidate.getModuleSpecifierSourceFile() === target &&
          candidate.getNamespaceImport() === undefined &&
          (!candidate.isTypeOnly() || typeOnly)
      );
    const moduleSpecifier = importSpecifierFor(
      importer,
      target,
      declaration.getModuleSpecifierValue()
    );
    if (destination !== undefined) {
      if (!before.has(destination)) {
        before.set(destination, destination.getText());
      }
      destination.addNamedImports(
        bindings.map((binding) => ({
          ...binding,
          isTypeOnly: !destination.isTypeOnly() && binding.isTypeOnly,
        }))
      );
      after.add(destination);
      removeMoved(declaration, moved);
    } else if (
      moved.length === declaration.getNamedImports().length &&
      declaration.getDefaultImport() === undefined
    ) {
      declaration.setModuleSpecifier(moduleSpecifier);
      declaration.set({
        ...declaration.getStructure(),
        namedImports: bindings.map((binding) => ({
          ...binding,
          isTypeOnly: !declaration.isTypeOnly() && binding.isTypeOnly,
        })),
      });
      after.add(declaration);
    } else {
      const index = importer.getStatements().indexOf(declaration);
      const added = importer.insertImportDeclaration(index + 1, {
        ...declaration.getStructure(),
        defaultImport: undefined,
        isTypeOnly: declaration.isTypeOnly(),
        moduleSpecifier,
        namedImports: bindings.map((binding) => ({
          ...binding,
          isTypeOnly: !declaration.isTypeOnly() && binding.isTypeOnly,
        })),
      });
      after.add(added);
      removeMoved(declaration, moved);
    }
    if (!declaration.wasForgotten()) {
      after.add(declaration);
    }
  }
  return before.size === 0
    ? undefined
    : {
        after: [...after]
          .filter((declaration) => !declaration.wasForgotten())
          .sort((a, b) => a.getStart() - b.getStart())
          .map((declaration) => declaration.getText())
          .join("\n"),
        before: [...before.values()].join("\n"),
      };
}

function removeMoved(
  declaration: ImportDeclaration,
  moved: ReturnType<ImportDeclaration["getNamedImports"]>
): void {
  if (
    moved.length === declaration.getNamedImports().length &&
    declaration.getDefaultImport() === undefined
  ) {
    declaration.remove();
    return;
  }
  for (const specifier of moved) {
    specifier.remove();
  }
}
