import { relative, resolve } from "node:path";
import type { SourceFile } from "ts-morph";
import { Node, Project } from "ts-morph";
import { editInternalImports } from "./apply-imports";
import type { InternalizeOperation } from "./internalize-operations";
import { internalizeOperations } from "./internalize-operations";
import type {
  InternalizeSymbolPlan,
  MutationEdit,
  PlanBlocker,
  PublicExposureRoute,
  SurfaceReport,
} from "./types";

/** The exact edits preview, authorization, and mutation share. Text retains source formatting. */
export interface InternalizeEdits {
  edits: MutationEdit[];
  files: { file: string; before: string; after: string }[];
  operations: InternalizeOperation[];
  planId: string;
  sources: string[];
}

/** Compile on a private in-memory project. The planning program is never changed. */
export function compileInternalizeEdits(
  source: Project,
  root: string,
  plan: InternalizeSymbolPlan,
  report: SurfaceReport
): InternalizeEdits | { blocker: PlanBlocker } {
  const project = new Project({
    compilerOptions: source.getCompilerOptions(),
    skipFileDependencyResolution: true,
    useInMemoryFileSystem: true,
  });
  // Clone only the edited files and their import/re-export closure. This
  // retains alias and barrel resolution without copying the whole workspace.
  const declaration = report.symbols.find(
    (symbol) => symbol.id === plan.subject.id
  )?.declarationFile;
  const pending = [
    ...plan.publicRoutes.map((route) => route.file),
    ...plan.plannedChanges.map((change) => change.file),
    ...(declaration === undefined ? [] : [declaration]),
  ].flatMap((file) => source.getSourceFile(resolve(root, file)) ?? []);
  const visited = new Set<string>();
  while (pending.length > 0) {
    const file = pending.pop();
    if (file === undefined || visited.has(file.getFilePath())) {
      continue;
    }
    visited.add(file.getFilePath());
    project.createSourceFile(file.getFilePath(), file.getFullText());
    for (const statement of [
      ...file.getImportDeclarations(),
      ...file.getExportDeclarations(),
    ]) {
      const dependency = statement.getModuleSpecifierSourceFile();
      if (
        dependency !== undefined &&
        !dependency.isInNodeModules() &&
        !dependency.isDeclarationFile()
      ) {
        pending.push(dependency);
      }
    }
  }
  const compiled = editPlan(project, root, plan, report);
  if ("blocker" in compiled) {
    return compiled;
  }
  return {
    edits: compiled.edits,
    files: [...compiled.files].map(([file, edited]) => {
      const original = source.getSourceFileOrThrow(resolve(root, file));
      return {
        after: edited.getFullText(),
        before: original.getFullText(),
        file,
      };
    }),
    operations: internalizeOperations(source, project, root, plan, report),
    planId: plan.id,
    sources: [...visited]
      .map((file) => relative(root, file).replaceAll("\\", "/"))
      .sort(),
  };
}

/** Install exactly the compiled text in the mutator's private program, after checking every source. */
function materializeInternalizeEdits(
  project: Project,
  root: string,
  prepared: InternalizeEdits
):
  | { edits: MutationEdit[]; files: Map<string, SourceFile> }
  | { blocker: PlanBlocker } {
  for (const edit of prepared.files) {
    if (
      project.getSourceFile(resolve(root, edit.file))?.getFullText() !==
      edit.before
    ) {
      return {
        blocker: {
          detail: `${edit.file} changed since its edits were compiled.`,
          reason: "stale-plan",
        },
      };
    }
  }
  const files = new Map<string, SourceFile>();
  for (const edit of prepared.files) {
    const file = project.getSourceFileOrThrow(resolve(root, edit.file));
    file.replaceWithText(edit.after);
    files.set(edit.file, file);
  }
  return { edits: prepared.edits, files };
}

/** A statement's first line, which names a declaration without its body. */
function firstLine(text: string): string {
  return text.split("\n")[0] ?? text;
}

/** A declaration's header: its first line after any decorators, which may stand on lines of their own. */
function header(node: Node): string {
  const decorators = Node.isDecoratable(node) ? node.getDecorators() : [];
  const last = decorators.at(-1);
  const text = node.getText();
  return firstLine(
    last === undefined
      ? text
      : text.slice(last.getEnd() - node.getStart()).trimStart()
  );
}

/** Narrows one route, in memory, and says how the statement reads before and after. */
function editRoute(
  file: SourceFile,
  route: PublicExposureRoute
): { edit: MutationEdit } | { blocker: PlanBlocker } {
  const edit = (before: string, after: string | null) => ({
    edit: { after, before, file: route.file },
  });
  if (route.statement !== undefined) {
    for (const declaration of file.getExportDeclarations()) {
      const specifier = declaration
        .getNamedExports()
        .find(
          (spec) =>
            (spec.getAliasNode()?.getText() ?? spec.getName()) ===
            route.exportedName
        );
      if (specifier === undefined) {
        continue;
      }
      const before = declaration.getText();
      if (declaration.getNamedExports().length > 1) {
        specifier.remove();
        return edit(before, declaration.getText());
      }
      declaration.remove();
      return edit(before, null);
    }
    return {
      blocker: {
        detail: `No export statement exposing ${route.exportedName} found in ${route.file}.`,
        reason: "apply-unsupported",
      },
    };
  }
  const declarations = file.getExportedDeclarations().get(route.exportedName);
  const declaration = declarations?.find(
    (candidate) => candidate.getSourceFile() === file
  );
  if (declaration === undefined) {
    return {
      blocker: {
        detail: `No exported declaration of ${route.exportedName} found in ${route.file}.`,
        reason: "apply-unsupported",
      },
    };
  }
  if (Node.isVariableDeclaration(declaration)) {
    const statement = declaration.getVariableStatement();
    if (statement === undefined || statement.getDeclarations().length > 1) {
      return {
        blocker: {
          detail: `${route.exportedName} shares a variable statement with other declarations in ${route.file}.`,
          reason: "apply-unsupported",
        },
      };
    }
    const before = firstLine(statement.getText());
    statement.setIsExported(false);
    return edit(before, firstLine(statement.getText()));
  }
  if (
    Node.isFunctionDeclaration(declaration) ||
    Node.isClassDeclaration(declaration) ||
    Node.isInterfaceDeclaration(declaration) ||
    Node.isTypeAliasDeclaration(declaration) ||
    Node.isEnumDeclaration(declaration) ||
    Node.isModuleDeclaration(declaration)
  ) {
    const before = header(declaration);
    declaration.setIsExported(false);
    return edit(before, header(declaration));
  }
  return {
    blocker: {
      detail: `The declaration of ${route.exportedName} in ${route.file} is not a supported exportable form.`,
      reason: "apply-unsupported",
    },
  };
}

/** Importers are repointed in memory before narrowing the public routes. */
function editPlan(
  project: Project,
  root: string,
  plan: InternalizeSymbolPlan,
  before: SurfaceReport
) {
  const imports = editInternalImports(project, root, plan, before);
  if ("blocker" in imports) {
    return imports;
  }
  const routes = editRoutes(project, root, plan.publicRoutes);
  if ("blocker" in routes) {
    return routes;
  }
  return {
    edits: [...imports.edits, ...routes.edits],
    files: new Map([...imports.files, ...routes.files]),
  };
}

/** Every route narrowed in memory, in route order, with the files they touch by root-relative path. */
function editRoutes(
  project: Project,
  root: string,
  routes: readonly PublicExposureRoute[]
):
  | { edits: MutationEdit[]; files: Map<string, SourceFile> }
  | { blocker: PlanBlocker } {
  const edits: MutationEdit[] = [];
  const files = new Map<string, SourceFile>();
  for (const route of routes) {
    const file = project.getSourceFile(resolve(root, route.file));
    if (file === undefined) {
      return {
        blocker: {
          detail: `Planned file ${route.file} is not part of the analyzed project.`,
          reason: "apply-unsupported",
        },
      };
    }
    const edited = editRoute(file, route);
    if ("blocker" in edited) {
      return edited;
    }
    edits.push(edited.edit);
    files.set(route.file, file);
  }
  return { edits, files };
}

/** The mutator uses a supplied compiled batch or compiles through the same path for a direct call. */
export function prepareInternalizeEdits(
  project: Project,
  root: string,
  plan: InternalizeSymbolPlan,
  report: SurfaceReport,
  prepared?: InternalizeEdits
) {
  const batch =
    prepared ?? compileInternalizeEdits(project, root, plan, report);
  if ("blocker" in batch) {
    return batch;
  }
  if (batch.planId !== plan.id) {
    return {
      blocker: {
        detail: "The compiled edits belong to another plan.",
        reason: "stale-plan" as const,
      },
    };
  }
  return materializeInternalizeEdits(project, root, batch);
}
