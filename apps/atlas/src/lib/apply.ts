import { execFileSync } from "node:child_process";
import { readFileSync, realpathSync, writeFileSync } from "node:fs";
import { resolve, sep } from "node:path";
import type { Project, SourceFile } from "ts-morph";

import { Node, ts } from "ts-morph";
import { analyzeSurface } from "./analyze";
import { findRepoRoot } from "./boundary";
import { createProject } from "./project";
import type {
  InternalizeSymbolPlan,
  MutationResult,
  PlanBlocker,
  PublicExposureRoute,
  ReductionPlan,
  StructuralDelta,
  SurfaceReport,
  VerificationCheck,
  VerificationResult,
} from "./types";
import { validateReductionPlan } from "./validate";

// The only mutating operator: internalize-export. It narrows a symbol's
// package-public exposure — it never deletes the symbol, its implementation,
// or its internal module export. Everything else in this package stays
// read-only, and even this path defaults to preview: nothing is written
// without an explicit write request, and a failed verification restores the
// exact pre-mutation file contents.

export interface ApplyOptions {
  /** Monorepo root. Defaults to the nearest ancestor of cwd with a workspaces field. */
  root?: string;
  tsconfig?: string;
  /** Write the planned changes. Default false: preview only, no file writes. */
  write?: boolean;
}

/** Planned files with uncommitted changes (any porcelain status). Empty when git is unavailable. */
function dirtyPlannedFiles(root: string, files: string[]): string[] {
  try {
    const output = execFileSync(
      "git",
      ["status", "--porcelain", "--", ...files],
      { cwd: root, stdio: ["ignore", "pipe", "ignore"] }
    ).toString();
    return output
      .split("\n")
      .filter((line) => line.length > 3)
      .map((line) => line.slice(3).trim());
  } catch {
    return [];
  }
}

/** Error-severity diagnostic counts per file+code for files under `dir`. */
function diagnosticCounts(project: Project, dir: string): Map<string, number> {
  const prefix = dir.endsWith(sep) ? dir : dir + sep;
  const counts = new Map<string, number>();
  for (const file of project.getSourceFiles()) {
    if (!file.getFilePath().startsWith(prefix)) {
      continue;
    }
    for (const diagnostic of file.getPreEmitDiagnostics()) {
      if (diagnostic.getCategory() !== ts.DiagnosticCategory.Error) {
        continue;
      }
      const key = `${file.getFilePath()}|${diagnostic.getCode()}`;
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
  }
  return counts;
}

function newDiagnostics(
  before: Map<string, number>,
  after: Map<string, number>
): string[] {
  const introduced: string[] = [];
  for (const [key, count] of after) {
    if (count > (before.get(key) ?? 0)) {
      introduced.push(key);
    }
  }
  return introduced.sort((a, b) => a.localeCompare(b));
}

function editRoute(
  file: SourceFile,
  route: PublicExposureRoute
): PlanBlocker | undefined {
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
      if (declaration.getNamedExports().length > 1) {
        specifier.remove();
      } else {
        declaration.remove();
      }
      return undefined;
    }
    return {
      detail: `No export statement exposing ${route.exportedName} found in ${route.file}.`,
      reason: "apply-unsupported",
    };
  }
  const declarations = file.getExportedDeclarations().get(route.exportedName);
  const declaration = declarations?.find(
    (candidate) => candidate.getSourceFile() === file
  );
  if (declaration === undefined) {
    return {
      detail: `No exported declaration of ${route.exportedName} found in ${route.file}.`,
      reason: "apply-unsupported",
    };
  }
  if (Node.isVariableDeclaration(declaration)) {
    const statement = declaration.getVariableStatement();
    if (statement === undefined || statement.getDeclarations().length > 1) {
      return {
        detail: `${route.exportedName} shares a variable statement with other declarations in ${route.file}.`,
        reason: "apply-unsupported",
      };
    }
    statement.setIsExported(false);
    return undefined;
  }
  if (
    Node.isFunctionDeclaration(declaration) ||
    Node.isClassDeclaration(declaration) ||
    Node.isInterfaceDeclaration(declaration) ||
    Node.isTypeAliasDeclaration(declaration) ||
    Node.isEnumDeclaration(declaration) ||
    Node.isModuleDeclaration(declaration)
  ) {
    declaration.setIsExported(false);
    return undefined;
  }
  return {
    detail: `The declaration of ${route.exportedName} in ${route.file} is not a supported exportable form.`,
    reason: "apply-unsupported",
  };
}

function routesRemaining(
  plan: InternalizeSymbolPlan,
  after: SurfaceReport
): PublicExposureRoute[] {
  const afterPlan = after.plans.find(
    (candidate): candidate is InternalizeSymbolPlan =>
      candidate.operation === "internalize-symbol" &&
      candidate.subject.id === plan.subject.id
  );
  return afterPlan?.publicRoutes ?? [];
}

/**
 * Structural verification of an applied internalize-export: proves the symbol
 * left the package-public surface without disturbing anything else. Deltas
 * use package-public semantics (route disappearance), matching the plan's
 * prediction — not the module-level summary counts, which deliberately do not
 * move when the declaring module keeps its own export.
 */
export function verifyInternalizeExport(
  plan: InternalizeSymbolPlan,
  before: SurfaceReport,
  after: SurfaceReport
): VerificationResult {
  const checks: VerificationCheck[] = [];
  const afterSymbol = after.symbols.find(
    (symbol) => symbol.id === plan.subject.id
  );
  checks.push({
    check: "symbol still exists",
    detail:
      afterSymbol === undefined
        ? `${plan.subject.name} no longer resolves; internalization must not delete the symbol.`
        : `${plan.subject.name} still declared in ${afterSymbol.declarationFile}.`,
    status: afterSymbol === undefined ? "fail" : "pass",
  });

  const remaining = routesRemaining(plan, after);
  const stillPublic = remaining.length > 0;
  checks.push({
    check: "symbol no longer package-public",
    detail: stillPublic
      ? `${plan.subject.name} remains public through: ${remaining.map((route) => route.entrypoint).join(", ")}.`
      : `No route through the declared entrypoints exposes ${plan.subject.name}.`,
    status: stillPublic ? "fail" : "pass",
  });

  const usageUnchanged =
    (afterSymbol?.externalReferences ?? 0) === 0 &&
    (afterSymbol?.externalImportSites ?? 0) === 0;
  checks.push({
    check: "external usage unchanged",
    detail: usageUnchanged
      ? "External references and import sites remain zero."
      : `${plan.subject.name} now shows external usage; the pre-mutation facts did not hold.`,
    status: usageUnchanged ? "pass" : "fail",
  });

  const observedDelta: StructuralDelta = {
    exportedSymbols: stillPublic ? 0 : -1,
    externallyUsedSymbols:
      after.summary.externallyUsedSymbols -
      before.summary.externallyUsedSymbols,
    totalSymbols: after.summary.totalSymbols - before.summary.totalSymbols,
    unusedExternalExports: stillPublic ? 0 : -1,
  };
  const predicted = plan.predictedDelta;
  const deltaMatches = (
    [
      "totalSymbols",
      "exportedSymbols",
      "externallyUsedSymbols",
      "unusedExternalExports",
    ] as const
  ).every((key) => (predicted[key] ?? 0) === (observedDelta[key] ?? 0));
  checks.push({
    check: "observed delta matches prediction",
    detail: deltaMatches
      ? "The package-public surface changed exactly as predicted."
      : `Predicted ${JSON.stringify(predicted)} but observed ${JSON.stringify(observedDelta)}.`,
    status: deltaMatches ? "pass" : "fail",
  });

  return {
    checks,
    observedDelta,
    predictedDelta: predicted,
    status: checks.every((check) => check.status === "pass") ? "pass" : "fail",
  };
}

function result(
  plan: ReductionPlan,
  status: MutationResult["status"],
  predictedDelta: StructuralDelta,
  extras: Partial<MutationResult> = {}
): MutationResult {
  return {
    changedFiles: [],
    operator:
      plan.operation === "fold-package" ? "fold-package" : "internalize-export",
    plan,
    predictedDelta,
    status,
    ...extras,
  };
}

/**
 * Run a plan through the mutation lifecycle: revalidate against a fresh
 * analysis, protect dirty files, edit deterministically, and — only with
 * `write` — save, verify, and roll back on any verification failure. Without
 * `write` this is a preview: no file is ever modified.
 */
export async function applyReductionPlan(
  plan: ReductionPlan,
  options: ApplyOptions = {}
): Promise<MutationResult> {
  if (plan.operation === "fold-package") {
    return result(plan, "unsupported", plan.predictedDelta.certain, {
      blockers: [
        {
          detail: "fold-package mutation is not implemented.",
          reason: "apply-unsupported",
        },
      ],
    });
  }

  const root = realpathSync(
    options.root ? resolve(options.root) : findRepoRoot(process.cwd())
  );
  const analyzeOptions = {
    root,
    target: plan.target.path,
    ...(options.tsconfig !== undefined && { tsconfig: options.tsconfig }),
  };
  const before = await analyzeSurface(analyzeOptions);
  const validation = validateReductionPlan(plan, before);
  if (validation.status !== "ready") {
    const status = validation.status === "stale" ? "stale" : validation.status;
    return result(plan, status, plan.predictedDelta, {
      blockers: validation.blockers,
    });
  }
  const freshPlan = before.plans.find(
    (candidate): candidate is InternalizeSymbolPlan =>
      candidate.operation === "internalize-symbol" &&
      candidate.subject.id === plan.subject.id
  );
  if (freshPlan === undefined) {
    throw new Error(`Validated plan has no fresh counterpart: ${plan.id}`);
  }

  const changedFiles = [
    ...new Set(freshPlan.publicRoutes.map((route) => route.file)),
  ].sort((a, b) => a.localeCompare(b));
  const dirty = dirtyPlannedFiles(root, changedFiles);
  if (dirty.length > 0) {
    return result(plan, "blocked", plan.predictedDelta, {
      blockers: dirty.map((file) => ({
        detail: `Planned file has existing uncommitted changes: ${file}`,
        reason: "dirty-working-tree",
      })),
    });
  }

  const originals = new Map<string, string>();
  for (const file of changedFiles) {
    originals.set(file, readFileSync(resolve(root, file), "utf8"));
  }

  const project = createProject(root, options.tsconfig);
  const boundaryDir = resolve(root, plan.target.path);
  const baseline = diagnosticCounts(project, boundaryDir);

  const editedFiles: SourceFile[] = [];
  for (const route of freshPlan.publicRoutes) {
    const file = project.getSourceFile(resolve(root, route.file));
    if (file === undefined) {
      return result(plan, "blocked", plan.predictedDelta, {
        blockers: [
          {
            detail: `Planned file ${route.file} is not part of the analyzed project.`,
            reason: "apply-unsupported",
          },
        ],
      });
    }
    const blocker = editRoute(file, route);
    if (blocker !== undefined) {
      return result(plan, "blocked", plan.predictedDelta, {
        blockers: [blocker],
      });
    }
    if (!editedFiles.includes(file)) {
      editedFiles.push(file);
    }
  }

  if (options.write !== true) {
    return result(plan, "preview", plan.predictedDelta, { changedFiles });
  }

  const verification: VerificationResult = await collectIntroduced(
    editedFiles,
    baseline,
    project,
    boundaryDir,
    analyzeOptions,
    plan,
    before
  );

  if (verification.status === "fail") {
    for (const [file, content] of originals) {
      writeFileSync(resolve(root, file), content);
    }
    return result(plan, "rolled-back", plan.predictedDelta, {
      blockers: [
        {
          detail:
            "Post-mutation verification failed; all planned files were restored to their pre-mutation contents.",
          reason: "verification-failed",
        },
      ],
      changedFiles,
      observedDelta: verification.observedDelta,
      verification,
    });
  }

  return result(plan, "applied", plan.predictedDelta, {
    changedFiles,
    observedDelta: verification.observedDelta,
    verification,
  });
}

async function collectIntroduced(
  editedFiles: SourceFile[],
  baseline: Map<string, number>,
  project: Project,
  boundaryDir: string,
  analyzeOptions: {
    tsconfig?: string | undefined;
    root: string;
    target: string;
  },
  plan: InternalizeSymbolPlan,
  before: SurfaceReport
) {
  for (const file of editedFiles) {
    file.saveSync();
  }

  const introduced = newDiagnostics(
    baseline,
    diagnosticCounts(project, boundaryDir)
  );
  const typescriptCheck: VerificationCheck = {
    check: "typescript",
    detail:
      introduced.length === 0
        ? "No new TypeScript errors in the target package."
        : `New TypeScript errors: ${introduced.join(", ")}.`,
    status: introduced.length === 0 ? "pass" : "fail",
  };

  const after = await analyzeSurface(analyzeOptions);
  const structural = verifyInternalizeExport(plan, before, after);
  const verification: VerificationResult = {
    checks: [typescriptCheck, ...structural.checks],
    observedDelta: structural.observedDelta,
    predictedDelta: structural.predictedDelta,
    status:
      typescriptCheck.status === "pass" && structural.status === "pass"
        ? "pass"
        : "fail",
  };
  return verification;
}
