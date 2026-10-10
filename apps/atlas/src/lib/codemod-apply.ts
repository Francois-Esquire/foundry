import { readFileSync, rmSync } from "node:fs";
import { isMissingPath } from "@foundry/lib/atomic-file";
import { analyzeSurface } from "./analyze";
import type { RestorableFile } from "./apply";
import {
  applyReductionPlan,
  DIRTY_DETAIL,
  RestoreError,
  restoreWritten,
  sha256,
} from "./apply";
import type { ApplyJournal } from "./apply-journal";
import {
  deleteJournal,
  journalPath,
  readJournal,
  writeJournal,
} from "./apply-journal";
import { loadConfiguration } from "./atlas-config";
import { authorizeSite, planRecordFile } from "./codemod";
import type {
  ApplyRefusal,
  ApplyResult,
  ApplyScan,
  MovedPart,
  Site,
} from "./codemod-types";
import { savedDataset } from "./dataset-files";
import type { ReadinessCommandRunner } from "./operator-readiness";
import { commandResult, spawnRunner } from "./operator-readiness";
import type {
  AuthorizedMutationPlan,
  OperatorPlanReadiness,
} from "./operator-readiness-types";
import { AUTHORIZED_MUTATION_PLAN_SCHEMA_VERSION } from "./operator-readiness-types";
import type { ScanProgressEvent } from "./scan";
import { publishAfterWrite } from "./scan";
import type { SemanticsConfig } from "./semantics-types";
import type { WorkspaceState } from "./state";
import { lockState } from "./state";
import type {
  AnalyzeSurfaceOptions,
  InternalizeSymbolPlan,
  MutationResult,
  VerificationCheck,
} from "./types";

// `atlas apply`: the plan `atlas plan` authorized, applied by its mutator,
// `internalize-export`. Apply never trusts the record on its own: under the
// state lock it loads the configuration's rules, authorizes again, fresh,
// and goes on only when the `auth:` hash and the saved plan are the record's.
// A write is journaled, flushed to disk, before the first source write; it
// is verified (TypeScript, the structural proof, and the workspace's own
// scripts run again against the baseline taken under the lock); any failed
// check, error, or interrupting signal restores every written file; and a
// verified write is followed by a scan, staged and swapped in, after which
// the record and then the journal go.

/** A record as apply loaded it: parsed, and its text, so apply deletes it only while the file is still the one it loaded. */
interface LoadedRecord {
  record: AuthorizedMutationPlan;
  text: string;
}

/** The authorization record `atlas plan` saved for a site; none saved fails, and asks for a plan. */
function loadRecord(workspace: WorkspaceState, site: Site): LoadedRecord {
  const file = planRecordFile(workspace, site.planId);
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch (error) {
    if (isMissingPath(error)) {
      throw new Error(
        `No authorized plan is saved for ${site.opportunity}. Run atlas plan ${site.opportunity} first.`,
        { cause: error }
      );
    }
    throw error;
  }
  const malformed = (cause?: unknown) =>
    new Error(
      `${file} is not a record atlas plan saved. Run atlas plan ${site.opportunity} again.`,
      { cause }
    );
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw malformed(error);
  }
  if (!isRecordShaped(parsed)) {
    throw malformed();
  }
  return { record: parsed, text };
}

/**
 * Whether a parsed file has the record's fields that apply compares; their
 * values are judged against a fresh authorization, never trusted. A record
 * of another schema version passes on its version alone, whatever its
 * fields, so that it is reported as another Atlas's record.
 */
function isRecordShaped(value: unknown): value is AuthorizedMutationPlan {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const record = value as Partial<
    Record<keyof AuthorizedMutationPlan, unknown>
  >;
  if (typeof record.schemaVersion !== "number") {
    return false;
  }
  if (record.schemaVersion !== AUTHORIZED_MUTATION_PLAN_SCHEMA_VERSION) {
    return true;
  }
  return (
    typeof record.authorizationFingerprint === "object" &&
    record.authorizationFingerprint !== null &&
    typeof record.execution === "object" &&
    record.execution !== null &&
    Array.isArray(record.sourceFiles)
  );
}

/** The authorization's parts, in the order a moved one is reported. */
const PARTS = [
  ["source", "sourceFingerprint"],
  ["rule", "ruleFingerprint"],
  ["capability", "capabilityFingerprint"],
  ["verification", "verificationFingerprint"],
  ["plan", "planFingerprint"],
  ["rollback", "rollbackFingerprint"],
] as const;

/** The files whose hash differs between two records, or that only one names. */
function movedFiles(
  recorded: AuthorizedMutationPlan,
  fresh: AuthorizedMutationPlan
): string[] {
  const hashes = (record: AuthorizedMutationPlan) =>
    new Map(record.sourceFiles.map((f) => [f.file, f.hash]));
  const before = hashes(recorded);
  const after = hashes(fresh);
  return [...new Set([...before.keys(), ...after.keys()])]
    .filter((file) => before.get(file) !== after.get(file))
    .sort((a, b) => a.localeCompare(b));
}

/**
 * What moved between the record and a fresh authorization: none when every
 * part, the saved plan, and the hash are the record's. The saved plan's own
 * id and fingerprint count as the plan. Every part the same but another
 * hash, or another record schema, means another Atlas made the record.
 */
function movedParts(
  recorded: AuthorizedMutationPlan,
  fresh: AuthorizedMutationPlan
): MovedPart[] {
  if (recorded.schemaVersion !== AUTHORIZED_MUTATION_PLAN_SCHEMA_VERSION) {
    return [{ part: "atlas-version" }];
  }
  const sameExecution =
    recorded.execution.planId === fresh.execution.planId &&
    recorded.execution.planFingerprint === fresh.execution.planFingerprint &&
    recorded.execution.mutator === fresh.execution.mutator;
  const parts: MovedPart[] = PARTS.filter(
    ([part, key]) =>
      recorded.authorizationFingerprint[key] !==
        fresh.authorizationFingerprint[key] ||
      (part === "plan" && !sameExecution)
  ).map(([part]) =>
    part === "source" ? { files: movedFiles(recorded, fresh), part } : { part }
  );
  if (parts.length > 0) {
    return parts;
  }
  return recorded.authorizationFingerprint.hash ===
    fresh.authorizationFingerprint.hash
    ? []
    : [{ part: "atlas-version" }];
}

/**
 * Why the rollback could not restore the write: it would create or delete a
 * file, or a file the mutator writes is not one it can restore.
 */
function rollbackRefusal(
  readiness: OperatorPlanReadiness,
  written: readonly string[]
): string | undefined {
  const { createdFiles, deletedFiles, files } = readiness.rollback;
  if (createdFiles.length > 0 || deletedFiles.length > 0) {
    return `the plan creates or deletes files (${[...createdFiles, ...deletedFiles].join(", ")}), which no restore undoes`;
  }
  const restorable = new Set(
    files.filter((f) => f.restorable).map((f) => f.file)
  );
  const unrestorable = written.filter((file) => !restorable.has(file));
  return unrestorable.length > 0
    ? `the rollback cannot restore ${unrestorable.join(", ")}`
    : undefined;
}

/**
 * The mutator's own refusal: a written file dirty or no Git to tell, as it
 * found them when it looked, else its fresh analysis's stale, blocked, or
 * unsupported plan.
 */
function mutatorRefusal(mutation: MutationResult): ApplyRefusal | undefined {
  const blockers = mutation.blockers ?? [];
  const dirty = blockers.filter((b) => b.reason === "dirty-working-tree");
  if (dirty.length > 0) {
    return {
      files: dirty.map((b) => b.detail.slice(DIRTY_DETAIL.length)),
      kind: "dirty",
    };
  }
  const noGit = blockers.find((b) => b.reason === "no-git");
  if (noGit !== undefined) {
    return { kind: "no-git", reason: noGit.detail };
  }
  const { status } = mutation;
  if (status === "blocked" || status === "stale" || status === "unsupported") {
    return { blockers: mutation.blockers ?? [], kind: "revalidation", status };
  }
}

/** Where an interrupting signal comes from: the process, unless a test stands in. */
interface SignalSource {
  off(
    signal: NodeJS.Signals,
    listener: (signal: NodeJS.Signals) => void
  ): unknown;
  on(
    signal: NodeJS.Signals,
    listener: (signal: NodeJS.Signals) => void
  ): unknown;
}

const INTERRUPTS: readonly NodeJS.Signals[] = ["SIGINT", "SIGTERM"];

/** A write stopped by SIGINT or SIGTERM; every file it wrote is restored by the time it reaches the caller. */
export class InterruptedError extends Error {
  override readonly name = "InterruptedError";
  readonly signal: NodeJS.Signals;
  constructor(signal: NodeJS.Signals) {
    super(`Interrupted by ${signal}; every file Atlas wrote is restored.`);
    this.signal = signal;
  }
}

/** Yields to the event loop once, so a signal delivered meanwhile reaches its listener. */
function macrotask(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

/**
 * Catches SIGINT and SIGTERM for the write and its checks, so that they do
 * not end the process mid-write. Bun runs a signal's listener only at the
 * next macrotask, never while a synchronous command runs, so `check` first
 * yields, then throws for a caught signal, inside the mutator's `try`,
 * which restores the files. Further signals are caught as well, so the
 * restore always finishes.
 */
function watchInterrupts(source: SignalSource) {
  let caught: NodeJS.Signals | undefined;
  const listener = (signal: NodeJS.Signals) => {
    caught ??= signal;
  };
  for (const signal of INTERRUPTS) {
    source.on(signal, listener);
  }
  return {
    async check(): Promise<void> {
      await macrotask();
      if (caught !== undefined) {
        throw new InterruptedError(caught);
      }
    },
    stop(): void {
      for (const signal of INTERRUPTS) {
        source.off(signal, listener);
      }
    },
  };
}

type Interrupts = ReturnType<typeof watchInterrupts>;

/**
 * Readiness's command steps run again after the write: each must exit 0, or
 * show no failure its baseline, run under the lock before the write, did
 * not (A6). A failure from before the write is not the write's.
 */
async function commandChecks(
  readiness: OperatorPlanReadiness,
  root: string,
  runner: ReadinessCommandRunner,
  interrupts: Interrupts,
  elapsed: { ms: number }
): Promise<VerificationCheck[]> {
  const checks: VerificationCheck[] = [];
  for (const step of readiness.verification.steps) {
    if (step.mode !== "command" || step.command === undefined) {
      continue;
    }
    await interrupts.check();
    const started = performance.now();
    const ran = runner(step.command, root);
    elapsed.ms += performance.now() - started;
    // An interrupt is a signal Atlas caught itself; a child killed on its
    // own, as by its timeout, is a failed step.
    await interrupts.check();
    const command = `${[step.command.executable, ...step.command.args].join(" ")} in ${step.command.cwd}`;
    const check = `${step.kind} · ${step.scope.join(", ")}`;
    if (ran.signal !== undefined) {
      checks.push({
        check,
        detail: `${command} was ${killedBecause(ran.signal, ran.code)}.`,
        status: "fail",
      });
      continue;
    }
    const after = commandResult(ran, step);
    const before =
      readiness.verification.baselineChecks.find((c) => c.id === step.id)
        ?.result?.failures ?? [];
    const introduced = after.failures.filter((f) => !before.includes(f));
    const passed = after.exitCode === 0 || introduced.length === 0;
    checks.push({
      check,
      detail: passed
        ? `${command} shows no failure it did not show before the write.`
        : `${command} fails where it did not before the write: ${introduced.slice(0, 5).join("; ")}`,
      status: passed ? "pass" : "fail",
    });
  }
  return checks;
}

/** Why a child was killed, from Node's code when it gives one. */
function killedBecause(
  signal: NodeJS.Signals,
  code: string | undefined
): string {
  switch (code) {
    case "ETIMEDOUT":
      return `killed by ${signal}: it ran past its timeout (ETIMEDOUT)`;
    case "ENOBUFS":
      return `killed by ${signal}: its output was larger than Atlas holds (ENOBUFS)`;
    default:
      return `killed by ${signal} (timed out or output too large?)`;
  }
}

/** A refused restore, with what the journal holds and the two ways out. */
function withJournalAdvice(
  error: RestoreError,
  workspace: WorkspaceState
): RestoreError {
  return new RestoreError(
    `${error.message} The journal, ${journalPath(workspace)}, keeps every original: restore each file it names from Git (its HEAD content) and the next atlas apply finishes the restore, or delete the journal to keep the files as they are.`,
    { cause: error.cause }
  );
}

/** Restores from the journal, flushed; a refused restore keeps the journal and says what to do. */
function restoreJournaled(
  workspace: WorkspaceState,
  journal: ApplyJournal,
  cause?: unknown
): { restored: string[]; skipped: string[] } {
  try {
    return restoreWritten(
      workspace.root,
      restorableOf(workspace, journal),
      cause
    );
  } catch (error) {
    throw error instanceof RestoreError
      ? withJournalAdvice(error, workspace)
      : error;
  }
}

/** A journal file as the mutator hands it over before the first write. */
function journalFileOf({ file, original, writtenHash }: RestorableFile) {
  return {
    file,
    mode: original.mode,
    original: original.bytes.toString("base64"),
    originalHash: sha256(original.bytes),
    writtenHash,
  };
}

/** A journal's files as the restore takes them; a copy that does not match its recorded hash is refused. */
function restorableOf(
  workspace: WorkspaceState,
  journal: ApplyJournal
): RestorableFile[] {
  return journal.files.map(
    ({ file, mode, original, originalHash, writtenHash }) => {
      const bytes = Buffer.from(original, "base64");
      if (sha256(bytes) !== originalHash) {
        throw new Error(
          `The journal, ${journalPath(workspace)}, holds a damaged copy of ${file}: its bytes are not the ones it recorded. Restore ${file} from Git (its HEAD content), then delete the journal.`
        );
      }
      return { file, original: { bytes, mode }, writtenHash };
    }
  );
}

/**
 * An earlier apply that did not finish, under the lock. One interrupted
 * while it wrote is restored now, with the restore's guard, and its journal
 * deleted; a file changed since that write is left alone, the journal kept,
 * and the error names it. One that verified its write waits for a scan.
 */
function finishInterrupted(
  workspace: WorkspaceState
): ApplyRefusal | undefined {
  const journal = readJournal(workspace);
  if (journal === undefined) {
    return;
  }
  if (journal.phase === "verified") {
    return { kind: "pending-write", phase: "verified", site: journal.site };
  }
  const { restored, skipped } = restoreJournaled(workspace, journal);
  deleteJournal(workspace);
  return {
    kind: "pending-write",
    phase: "writing",
    restored,
    site: journal.site,
    skipped,
  };
}

/** Deletes the record only while the file is still the one apply loaded; a plan saved meanwhile is kept (A11). */
function deleteLoadedRecord(file: string, loaded: LoadedRecord): void {
  let current: string;
  try {
    current = readFileSync(file, "utf8");
  } catch (error) {
    if (isMissingPath(error)) {
      return;
    }
    throw error;
  }
  if (current === loaded.text) {
    rmSync(file, { force: true });
  }
}

export interface ApplyRecordOptions {
  /** Progress of the scan after a write. */
  onProgress?: (event: ScanProgressEvent) => void;
  /** The scan after a verified write; `publishAfterWrite` by default. A seam for the tests. */
  publish?: (
    state: WorkspaceState,
    config: SemanticsConfig,
    onProgress?: (event: ScanProgressEvent) => void
  ) => Promise<unknown>;
  /** Runs readiness's baseline commands, and runs them again after a write; by default they are spawned. */
  runner?: ReadinessCommandRunner;
  /** Where SIGINT and SIGTERM come from; the process by default. */
  signals?: SignalSource;
  state?: string | undefined;
  /** Write the change, verify it, and scan again. Default false: a preview. */
  write?: boolean;
}

/** What the write needs once every gate passed. */
interface WriteContext {
  base: Omit<ApplyResult, "status">;
  config: SemanticsConfig;
  loaded: LoadedRecord;
  options: ApplyRecordOptions;
  readiness: OperatorPlanReadiness;
  saved: InternalizeSymbolPlan;
  site: Site;
  workspace: WorkspaceState;
}

/**
 * The write, under the lock: journaled before the first source write,
 * verified, restored on any failure, error, or signal, and, once verified,
 * followed by the scan. A scan that fails leaves the verified write and its
 * journal: the next `atlas scan` publishes and finishes it (decision 9).
 */
async function writeVerified(context: WriteContext): Promise<ApplyResult> {
  const { base, config, loaded, options, readiness, site, workspace } = context;
  const elapsed = { ms: 0 };
  const { journaled, mutation } = await mutateJournaled(context, elapsed);
  const written = {
    ...base,
    changedFiles: mutation.changedFiles,
    edits: mutation.edits ?? [],
    timings: {
      afterMs: Math.round(elapsed.ms),
      baselineMs: readiness.timings.baselineMs,
    },
    ...(mutation.verification !== undefined && {
      verification: mutation.verification,
    }),
  };
  if (mutation.status !== "applied") {
    // Rolled back, or a write that never began, such as a file that moved
    // while the journal was flushed: nothing is left to restore.
    if (journaled) {
      deleteJournal(workspace);
    }
    if (mutation.status === "rolled-back") {
      return { ...written, status: "rolled-back" };
    }
    const refusal = mutatorRefusal(mutation);
    return {
      ...written,
      status: "refused",
      ...(refusal !== undefined && { refusal }),
    };
  }
  const journal = readJournal(workspace);
  if (journal !== undefined) {
    await writeJournal(workspace, { ...journal, phase: "verified" });
  }
  const scan = await scanAfterWrite(workspace, config, options);
  if (scan.status === "published") {
    deleteLoadedRecord(planRecordFile(workspace, site.planId), loaded);
    deleteJournal(workspace);
  }
  return { ...written, scan, status: "applied" };
}

/**
 * The mutator's write, inside the signal window: journaled before the first
 * write, every check preceded by a yield to the event loop, and one last
 * check once it returns `applied`. On any error the write is undone: the
 * mutator restores what it wrote before rethrowing, and a signal caught
 * after it returned is undone here, from the journal. A refused restore
 * keeps the journal.
 */
async function mutateJournaled(
  { options, readiness, saved, site, workspace }: WriteContext,
  elapsed: { ms: number }
): Promise<{ journaled: boolean; mutation: MutationResult }> {
  const runner = options.runner ?? spawnRunner;
  const interrupts = watchInterrupts(options.signals ?? process);
  let journaled = false;
  let applied = false;
  try {
    const mutation = await applyReductionPlan(saved, {
      afterChecks: () =>
        commandChecks(readiness, workspace.root, runner, interrupts, elapsed),
      analyzeAfter: async (analyzeOptions: AnalyzeSurfaceOptions) => {
        await interrupts.check();
        const after = await analyzeSurface(analyzeOptions);
        await interrupts.check();
        return after;
      },
      beforeWrite: async (files) => {
        // A signal during the analysis before the write writes nothing.
        await interrupts.check();
        await writeJournal(workspace, {
          files: files.map(journalFileOf),
          phase: "writing",
          planId: site.planId,
          schemaVersion: 1,
          site: site.place,
          startedAt: new Date().toISOString(),
        });
        journaled = true;
        // And once the journal is down: the write has not begun.
        await interrupts.check();
      },
      expectedHashes: new Map(
        readiness.rollback.files.map((f) => [f.file, f.hash])
      ),
      root: workspace.root,
      write: true,
    });
    applied = mutation.status === "applied";
    // A signal caught after the last check, and not yet acted on, undoes
    // the write before it is marked verified.
    if (applied) {
      await interrupts.check();
    }
    return { journaled, mutation };
  } catch (error) {
    throw undone(workspace, error, { applied, journaled });
  } finally {
    interrupts.stop();
  }
}

/** What a failed write throws, once it is undone: a refused restore with the journal's advice, else the error itself. */
function undone(
  workspace: WorkspaceState,
  error: unknown,
  { applied, journaled }: { applied: boolean; journaled: boolean }
): unknown {
  if (error instanceof RestoreError) {
    // Not restored: the journal keeps what the next apply needs.
    return journaled ? withJournalAdvice(error, workspace) : error;
  }
  const journal = applied ? readJournal(workspace) : undefined;
  if (journal !== undefined) {
    restoreJournaled(workspace, journal, error);
  }
  // Restored, or never written: the journal has nothing left to restore.
  if (journaled) {
    deleteJournal(workspace);
  }
  return error;
}

/** The scan after the write, as apply reports it; a failure is reported, not thrown. */
async function scanAfterWrite(
  workspace: WorkspaceState,
  config: SemanticsConfig,
  options: ApplyRecordOptions
): Promise<ApplyScan> {
  const publish = options.publish ?? publishAfterWrite;
  const started = performance.now();
  const durationMs = () => Math.round(performance.now() - started);
  try {
    await publish(workspace, config, options.onProgress);
    return {
      durationMs: durationMs(),
      output: workspace.output,
      status: "published",
    };
  } catch (error) {
    return {
      durationMs: durationMs(),
      error: error instanceof Error ? error.message : String(error),
      output: workspace.output,
      status: "failed",
    };
  }
}

/**
 * Applies the plan `atlas plan` authorized for a site: a preview, or with
 * `write` the write itself. Under the state lock it finishes an earlier
 * apply that did not (restoring an interrupted write), loads the
 * configuration's rules, authorizes the plan again, fresh (running the
 * baseline commands), and goes on only when the fresh record's `auth:` hash
 * and saved plan are the recorded ones, when the rollback can restore every
 * file the mutator writes, when none of them is dirty, and when the
 * mutator's own fresh analysis still agrees with the saved plan.
 */
export async function applyRecord(
  root: string,
  site: Site,
  options: ApplyRecordOptions = {}
): Promise<ApplyResult> {
  // A missing dataset fails before the lock creates the state directory.
  // The reader is made again under the lock, so no scan can publish
  // between the manifest it keeps and the reports it reads.
  const { workspace: unlocked } = await savedDataset(root, options.state);
  const release = lockState(unlocked);
  try {
    const { reader, workspace } = await savedDataset(root, options.state);
    const base = {
      changedFiles: [],
      edits: [],
      mode: options.write === true ? ("write" as const) : ("preview" as const),
      planId: site.planId,
      site: site.place,
    };
    const refused = (why: ApplyRefusal): ApplyResult => ({
      ...base,
      refusal: why,
      status: "refused",
    });
    const unfinished = finishInterrupted(workspace);
    if (unfinished !== undefined) {
      return refused(unfinished);
    }
    const loaded = loadRecord(workspace, site);
    const config = await loadConfiguration(workspace.root);
    const { saved, verdict } = await authorizeSite(
      reader,
      workspace,
      site,
      config.rules,
      options.runner
    );
    const written = [
      ...new Set(saved.publicRoutes.map((route) => route.file)),
    ].sort((a, b) => a.localeCompare(b));
    const gated = { ...base, changedFiles: written };
    const stop = (why: ApplyRefusal): ApplyResult => ({
      ...gated,
      refusal: why,
      status: "refused",
    });
    if (verdict.kind !== "authorized") {
      return stop(verdict);
    }
    const parts = movedParts(loaded.record, verdict.record);
    if (parts.length > 0) {
      return stop({ kind: "authorization-changed", parts });
    }
    const rollback = rollbackRefusal(verdict.readiness, written);
    if (rollback !== undefined) {
      return stop({ kind: "rollback", reason: rollback });
    }
    // Only a file the mutator writes blocks; any other dirty file stays a
    // caution in the readiness.
    const dirty = verdict.readiness.sourceState.git.plannedDirty.filter(
      (file) => written.includes(file)
    );
    if (dirty.length > 0) {
      return stop({ files: dirty, kind: "dirty" });
    }
    if (options.write === true) {
      return await writeVerified({
        base: gated,
        config,
        loaded,
        options,
        readiness: verdict.readiness,
        saved,
        site,
        workspace,
      });
    }
    const mutation = await applyReductionPlan(saved, { root: workspace.root });
    const refusal = mutatorRefusal(mutation);
    if (refusal !== undefined) {
      return stop(refusal);
    }
    return {
      ...gated,
      changedFiles: mutation.changedFiles,
      edits: mutation.edits ?? [],
      status: "preview",
    };
  } finally {
    release();
  }
}
