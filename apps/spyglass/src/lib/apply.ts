import { createHash } from "node:crypto";
import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { resolve, sep } from "node:path";
import { isMissingPath, writeFileAtomicSync } from "@foundry/lib/atomic-file";
import type { Project, SourceFile } from "ts-morph";

import { Node, ts } from "ts-morph";
import { analyzeSurface } from "./analyze";
import { editInternalImports } from "./apply-imports";
import { findRepoRoot } from "./boundary";
import { createProject } from "./project";
import type {
  AnalyzeSurfaceOptions,
  InternalizeSymbolPlan,
  MutationEdit,
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
import type { WorkingTree } from "./working-tree";
import { workingTree } from "./working-tree";

// The only mutating operator: internalize-export. It narrows a symbol's
// package-public exposure — it never deletes the symbol, its implementation,
// or its internal module export. Everything else in this package stays
// read-only, and even this path defaults to preview: nothing is written
// without an explicit write request, and a failed verification, or any
// error between the first write and the last check, restores the exact
// pre-mutation bytes and mode of every file it wrote. Each write and restore
// is a rename over the file, so it keeps the bytes and the mode, but not an
// owner other than Spyglass's user, extended attributes, ACLs, or other hard
// links to the file, which keep the old bytes. A crash mid-write can leave a
// `<file>.<uuid>.tmp` beside it, which is safe to delete.

export interface ApplyOptions {
  /**
   * More checks once the files are written and the structural checks ran,
   * such as the readiness commands run again; any that fails rolls back.
   */
  afterChecks?: () => Promise<VerificationCheck[]>;
  /**
   * The target's report once the files are written: `analyzeSurface` by
   * default; `spyglass apply` passes the staged scan's. Whatever it throws
   * restores the files as a failed check does.
   */
  analyzeAfter?: (options: AnalyzeSurfaceOptions) => Promise<SurfaceReport>;
  /**
   * The target's report before the write, to validate the plan against and
   * verify the write from: analyzed fresh by default; `spyglass apply` passes
   * the saved dataset's once it is proven current. It must agree with a
   * fresh analysis on every field validation and verification read.
   */
  before?: SurfaceReport;
  /**
   * Called once every file's written bytes are known and checked, before
   * the first write, so a caller can journal what a restore needs; required
   * to write. Whatever it throws stops the write; nothing has been written.
   */
  beforeWrite?: (files: readonly RestorableFile[]) => Promise<void>;
  /**
   * The SHA-256 each planned file must have just before the first write,
   * as readiness's rollback recorded it; a file missing here, or with
   * other bytes, stops the write as stale. Unchecked when absent.
   */
  expectedHashes?: ReadonlyMap<string, string>;
  /** Monorepo root. Defaults to the nearest ancestor of cwd with a workspaces field. */
  root?: string;
  tsconfig?: string;
  /** Write the planned changes. Default false: preview only, no file writes. */
  write?: boolean;
}

/** A planned file as it was before the mutation: its raw bytes and mode. */
interface Snapshot {
  bytes: Buffer;
  mode: number;
}

/** A file the mutation writes: its snapshot, and the hash of the bytes written over it, which the restore guard compares. */
export interface RestorableFile {
  file: string;
  original: Snapshot;
  /** SHA-256 of the written bytes. */
  writtenHash: string;
}

/** A file about to be written: what a restore needs, and the bytes. */
interface PendingWrite extends RestorableFile {
  written: Buffer;
}

/** Some written file could not be restored; it is left as it is, and the error names it. */
export class RestoreError extends Error {
  override readonly name = "RestoreError";
}

export function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

const BOM = Buffer.from([0xef, 0xbb, 0xbf]);
/** A mode's permission and special bits, the part a restore puts back; the rest says what kind of file it is. */
const PERMISSION_MODULUS = 0o1_0000;

/** The start of a dirty planned file's blocker detail; the file follows it. */
export const DIRTY_DETAIL = "Planned file has existing uncommitted changes: ";

/** Why a write cannot go ahead without a readable working tree, by what is missing. */
function noGit(tree: Exclude<WorkingTree, { kind: "repository" }>): string {
  switch (tree.kind) {
    case "git-missing":
      return "Git is not installed, so Spyglass cannot tell whether a planned file has uncommitted changes. Install Git to write.";
    case "not-a-repository":
      return "The workspace is not in a Git repository, so Spyglass cannot tell whether a planned file has uncommitted changes. Write only in a repository.";
    default:
      return `Git could not read the working tree, so Spyglass cannot tell whether a planned file has uncommitted changes: ${tree.message}`;
  }
}

/**
 * Why the planned files cannot be written now: a planned file with
 * uncommitted changes, or, for a write, no Git to tell. Only files the
 * mutator writes are checked; other dirty files are not its concern.
 */
function workingTreeBlockers(
  root: string,
  files: readonly string[],
  write: boolean
): PlanBlocker[] {
  const tree = workingTree(root);
  if (tree.kind !== "repository") {
    return write ? [{ detail: noGit(tree), reason: "no-git" }] : [];
  }
  return tree.dirty
    .filter((file) => files.includes(file))
    .sort((a, b) => a.localeCompare(b))
    .map((file) => ({
      detail: `${DIRTY_DETAIL}${file}`,
      reason: "dirty-working-tree",
    }));
}

/** Each planned file's raw bytes and mode; a symbolic link is refused, since Spyglass does not write through links. */
function snapshots(
  root: string,
  files: readonly string[]
): Map<string, Snapshot> | PlanBlocker {
  const taken = new Map<string, Snapshot>();
  for (const file of files) {
    const path = resolve(root, file);
    const stat = lstatSync(path);
    if (stat.isSymbolicLink()) {
      return {
        detail: `${file} is a symbolic link; Spyglass does not write through links.`,
        reason: "apply-unsupported",
      };
    }
    taken.set(file, {
      bytes: readFileSync(path),
      mode: stat.mode % PERMISSION_MODULUS,
    });
  }
  return taken;
}

/** A file's text as bytes to write; ts-morph drops a byte order mark, so the original's is kept. */
function writtenBytes(fullText: string, original: Snapshot): Buffer {
  const text = Buffer.from(fullText, "utf8");
  const bom = original.bytes.subarray(0, BOM.length).equals(BOM);
  return bom && !text.subarray(0, BOM.length).equals(BOM)
    ? Buffer.concat([BOM, text])
    : text;
}

/** A file's bytes, or undefined once it is gone; a restore cannot compare a missing file, so it leaves it alone. */
function readIfPresent(path: string): Buffer | undefined {
  try {
    return readFileSync(path);
  } catch (error) {
    if (isMissingPath(error)) {
      return undefined;
    }
    throw error;
  }
}

/**
 * Puts every written file back as it was, one at a time and atomically,
 * with its mode. A file that still holds its original bytes is left alone;
 * one that holds neither those nor the written bytes changed after the
 * write, so it is not overwritten. Each restore is flushed to disk. Every
 * file is tried; when any is left untouched or fails to restore, it throws
 * once, naming them all, with `cause` (the error that called for the
 * restore) or else the first failure as its cause. Otherwise it returns the
 * files it restored and those it found already as they were.
 */
export function restoreWritten(
  root: string,
  written: readonly RestorableFile[],
  cause?: unknown
): { restored: string[]; skipped: string[] } {
  const restored: string[] = [];
  const skipped: string[] = [];
  const untouched: string[] = [];
  const failed: { error: unknown; file: string }[] = [];
  for (const { file, original, writtenHash } of written) {
    const path = resolve(root, file);
    try {
      const current = readIfPresent(path);
      if (current?.equals(original.bytes)) {
        skipped.push(file);
        continue;
      }
      if (current !== undefined && sha256(current) === writtenHash) {
        writeFileAtomicSync(path, original.bytes, {
          fsync: true,
          mode: original.mode,
        });
        restored.push(file);
        continue;
      }
      untouched.push(file);
    } catch (error) {
      failed.push({ error, file });
    }
  }
  if (untouched.length === 0 && failed.length === 0) {
    return { restored, skipped };
  }
  const reasons = [
    ...(untouched.length > 0
      ? [
          `${untouched.join(", ")} changed after Spyglass wrote it, so restoring it would overwrite that change`,
        ]
      : []),
    ...failed.map(
      ({ error, file }) =>
        `restoring ${file} failed: ${error instanceof Error ? error.message : String(error)}`
    ),
  ];
  const files = [...untouched, ...failed.map(({ file }) => file)];
  throw new RestoreError(
    `Spyglass did not restore every file it wrote: ${reasons.join("; ")}. Restore ${files.join(", ")} from Git.`,
    { cause: cause ?? failed[0]?.error }
  );
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
  const before = options.before ?? (await analyzeSurface(analyzeOptions));
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
    ...new Set([
      ...freshPlan.publicRoutes.map((route) => route.file),
      ...freshPlan.plannedChanges
        .filter((change) => change.kind === "rewrite-import")
        .map((change) => change.file),
    ]),
  ].sort((a, b) => a.localeCompare(b));
  const write = options.write === true;
  const refused = workingTreeBlockers(root, changedFiles, write);
  if (refused.length > 0) {
    return result(plan, "blocked", plan.predictedDelta, { blockers: refused });
  }
  const originals = snapshots(root, changedFiles);
  if (!(originals instanceof Map)) {
    return result(plan, "blocked", plan.predictedDelta, {
      blockers: [originals],
    });
  }

  const project = createProject(root, options.tsconfig);
  const unfaithful = unfaithfulFile(project, root, originals);
  if (unfaithful !== undefined) {
    return result(plan, "blocked", plan.predictedDelta, {
      blockers: [unfaithful],
    });
  }
  const boundaryDir = resolve(root, plan.target.path);
  const baseline = diagnosticCounts(project, boundaryDir);

  const edited = editPlan(project, root, freshPlan, before);
  if ("blocker" in edited) {
    return result(plan, "blocked", plan.predictedDelta, {
      blockers: [edited.blocker],
    });
  }
  const { edits, files } = edited;
  if (!write) {
    return result(plan, "preview", plan.predictedDelta, {
      changedFiles,
      edits,
    });
  }

  const { beforeWrite } = options;
  if (beforeWrite === undefined) {
    throw new Error(
      "applyReductionPlan writes only with a beforeWrite journal, so that a crash mid-write can be restored."
    );
  }
  const pending = pendingWrites(files, originals);
  const staleBefore = staleBeforeWrite(root, pending, options.expectedHashes);
  if (staleBefore !== undefined) {
    return result(plan, "stale", plan.predictedDelta, {
      blockers: [staleBefore],
    });
  }
  await beforeWrite(
    pending.map(({ written: _bytes, ...restorable }) => restorable)
  );
  // Again once the journal is down: a file may have moved while it was
  // flushed. The caller deletes the journal of a write that never began.
  const staleAfter = staleBeforeWrite(root, pending, options.expectedHashes);
  if (staleAfter !== undefined) {
    return result(plan, "stale", plan.predictedDelta, {
      blockers: [staleAfter],
    });
  }
  const written: RestorableFile[] = [];
  let verification: VerificationResult;
  try {
    writeEdited(root, pending, written);
    verification = withChecks(
      await verifyWritten({
        analyze: options.analyzeAfter ?? analyzeSurface,
        analyzeOptions,
        baseline,
        before,
        boundaryDir,
        plan,
        project,
      }),
      (await options.afterChecks?.()) ?? []
    );
  } catch (error) {
    restoreWritten(root, written, error);
    throw error;
  }

  if (verification.status === "fail") {
    restoreWritten(root, written);
    return result(plan, "rolled-back", plan.predictedDelta, {
      blockers: [
        {
          detail:
            "Post-mutation verification failed; all planned files were restored to their pre-mutation contents.",
          reason: "verification-failed",
        },
      ],
      changedFiles,
      edits,
      observedDelta: verification.observedDelta,
      verification,
    });
  }

  return result(plan, "applied", plan.predictedDelta, {
    changedFiles,
    edits,
    observedDelta: verification.observedDelta,
    verification,
  });
}

/**
 * A planned file whose text, written back unedited, would not be its
 * snapshot's bytes: one that is not UTF-8, which the rewrite would
 * re-encode, or one that changed between the snapshot and the project's
 * read of it.
 */
function unfaithfulFile(
  project: Project,
  root: string,
  originals: ReadonlyMap<string, Snapshot>
): PlanBlocker | undefined {
  for (const [file, original] of originals) {
    const source = project.getSourceFile(resolve(root, file));
    if (
      source !== undefined &&
      !writtenBytes(source.getFullText(), original).equals(original.bytes)
    ) {
      return {
        detail: `${file} would not be written back byte for byte: it is not UTF-8, or it changed while Spyglass read it.`,
        reason: "apply-unsupported",
      };
    }
  }
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

/** Each edited file's snapshot and the bytes to write over it. */
function pendingWrites(
  files: ReadonlyMap<string, SourceFile>,
  originals: ReadonlyMap<string, Snapshot>
): PendingWrite[] {
  return [...files].map(([relative, file]) => {
    const original = originals.get(relative);
    if (original === undefined) {
      throw new Error(`No snapshot of ${relative}; nothing was written.`);
    }
    const written = writtenBytes(file.getFullText(), original);
    return { file: relative, original, written, writtenHash: sha256(written) };
  });
}

/**
 * Why the write cannot start: a planned file that no longer holds its
 * snapshot's bytes, read again now, or whose hash is not the one the
 * rollback recorded (A2). Nothing has been written yet.
 */
function staleBeforeWrite(
  root: string,
  pending: readonly PendingWrite[],
  expected: ReadonlyMap<string, string> | undefined
): PlanBlocker | undefined {
  for (const { file, original } of pending) {
    const current = readIfPresent(resolve(root, file));
    const hash = sha256(original.bytes);
    const moved =
      current === undefined ||
      !current.equals(original.bytes) ||
      (expected !== undefined && expected.get(file) !== hash);
    if (moved) {
      return {
        detail: `${file} is not the file readiness recorded for the rollback; it changed before the write. Nothing was written.`,
        reason: "stale-plan",
      };
    }
  }
}

/**
 * Writes each file atomically, with its original mode. Each is listed in
 * `written` before its write, so a failure part-way restores it too: the
 * restore leaves a file that still holds its original bytes alone.
 */
function writeEdited(
  root: string,
  pending: readonly PendingWrite[],
  written: RestorableFile[]
): void {
  for (const { written: bytes, ...restorable } of pending) {
    written.push(restorable);
    writeFileAtomicSync(resolve(root, restorable.file), bytes, {
      fsync: true,
      mode: restorable.original.mode,
    });
  }
}

/** A verification with more checks after its own; any that fails fails it. */
function withChecks(
  verification: VerificationResult,
  checks: readonly VerificationCheck[]
): VerificationResult {
  const all = [...verification.checks, ...checks];
  return {
    ...verification,
    checks: all,
    status: all.every((check) => check.status === "pass") ? "pass" : "fail",
  };
}

/** The checks after the write: no new TypeScript error in the package, and the structural proof. */
async function verifyWritten(context: {
  analyze: (options: AnalyzeSurfaceOptions) => Promise<SurfaceReport>;
  analyzeOptions: AnalyzeSurfaceOptions;
  baseline: Map<string, number>;
  before: SurfaceReport;
  boundaryDir: string;
  plan: InternalizeSymbolPlan;
  project: Project;
}): Promise<VerificationResult> {
  const { analyze, analyzeOptions, baseline, before, boundaryDir, plan } =
    context;
  const introduced = newDiagnostics(
    baseline,
    diagnosticCounts(context.project, boundaryDir)
  );
  const typescriptCheck: VerificationCheck = {
    check: "typescript",
    detail:
      introduced.length === 0
        ? "No new TypeScript errors in the target package."
        : `New TypeScript errors: ${introduced.join(", ")}.`,
    status: introduced.length === 0 ? "pass" : "fail",
  };
  const after = await analyze(analyzeOptions);
  const structural = verifyInternalizeExport(plan, before, after);
  return {
    checks: [typescriptCheck, ...structural.checks],
    observedDelta: structural.observedDelta,
    predictedDelta: structural.predictedDelta,
    status:
      typescriptCheck.status === "pass" && structural.status === "pass"
        ? "pass"
        : "fail",
  };
}
