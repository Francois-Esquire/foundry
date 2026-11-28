import { readFileSync, rmSync } from "node:fs";
import { isMissingPath } from "@foundry/lib/node/atomic-file";
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
import { authorizeSite, planRecordFile } from "./codemod";
import type {
  ApplyRefusal,
  ApplyResult,
  ApplyScan,
  MovedPart,
  Site,
} from "./codemod-types";
import type { PackageReport } from "./dataset";
import { datasetReader } from "./dataset";
import {
  datasetCurrency,
  STALE_DATASET,
  UNRECORDED_DATASET,
} from "./dataset-current";
import { fileTransport, savedDataset } from "./dataset-files";
import type { InternalizeEdits } from "./internalize-edits";
import type { ReadinessCommandRunner } from "./operator-readiness";
import { commandResult, spawnRunner } from "./operator-readiness";
import type {
  AuthorizedMutationPlan,
  OperatorPlanReadiness,
} from "./operator-readiness-types";
import { AUTHORIZED_MUTATION_PLAN_SCHEMA_VERSION } from "./operator-readiness-types";
import type { ScanProgressEvent } from "./scan";
import { discardStaged, publishStaged, stageAfterWrite } from "./scan";
import type { SemanticsConfig } from "./semantics-types";
import { loadConfiguration } from "./spyglass-config";
import type { WorkspaceState } from "./state";
import { lockState } from "./state";
import type {
  InternalizeSymbolPlan,
  MutationResult,
  VerificationCheck,
} from "./types";

interface LoadedRecord {
  record: AuthorizedMutationPlan;
  text: string;
}

function loadRecord(workspace: WorkspaceState, site: Site): LoadedRecord {
  const file = planRecordFile(workspace, site.planId);
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch (error) {
    if (isMissingPath(error)) {
      throw new Error(
        `No authorized plan is saved for ${site.opportunity}. Run spyglass plan ${site.opportunity} first.`,
        { cause: error }
      );
    }
    throw error;
  }
  const malformed = (cause?: unknown) =>
    new Error(
      `${file} is not a record spyglass plan saved. Run spyglass plan ${site.opportunity} again.`,
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

const PARTS = [
  ["source", "sourceFingerprint"],
  ["rule", "ruleFingerprint"],
  ["capability", "capabilityFingerprint"],
  ["verification", "verificationFingerprint"],
  ["plan", "planFingerprint"],
  ["rollback", "rollbackFingerprint"],
] as const;

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

function movedParts(
  recorded: AuthorizedMutationPlan,
  fresh: AuthorizedMutationPlan
): MovedPart[] {
  if (recorded.schemaVersion !== AUTHORIZED_MUTATION_PLAN_SCHEMA_VERSION) {
    return [{ part: "spyglass-version" }];
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
    : [{ part: "spyglass-version" }];
}

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

export class InterruptedError extends Error {
  override readonly name = "InterruptedError";
  readonly signal: NodeJS.Signals;
  constructor(signal: NodeJS.Signals) {
    super(`Interrupted by ${signal}; every file Spyglass wrote is restored.`);
    this.signal = signal;
  }
}

function macrotask(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

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

function killedBecause(
  signal: NodeJS.Signals,
  code: string | undefined
): string {
  switch (code) {
    case "ETIMEDOUT":
      return `killed by ${signal}: it ran past its timeout (ETIMEDOUT)`;
    case "ENOBUFS":
      return `killed by ${signal}: its output was larger than Spyglass holds (ENOBUFS)`;
    default:
      return `killed by ${signal} (timed out or output too large?)`;
  }
}

function withJournalAdvice(
  error: RestoreError,
  workspace: WorkspaceState
): RestoreError {
  return new RestoreError(
    `${error.message} The journal, ${journalPath(workspace)}, keeps every original: restore each file it names from Git (its HEAD content) and the next spyglass apply finishes the restore, or delete the journal to keep the files as they are.`,
    { cause: error.cause }
  );
}

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

function journalFileOf({ file, original, writtenHash }: RestorableFile) {
  return {
    file,
    mode: original.mode,
    original: original.bytes.toString("base64"),
    originalHash: sha256(original.bytes),
    writtenHash,
  };
}

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
  onProgress?: (event: ScanProgressEvent) => void;
  publish?: (state: WorkspaceState) => Promise<unknown>;
  runner?: ReadinessCommandRunner;
  signals?: SignalSource;
  state?: string | undefined;
  write?: boolean;
}

interface WriteContext {
  base: Omit<ApplyResult, "status">;
  config: SemanticsConfig;
  loaded: LoadedRecord;
  options: ApplyRecordOptions;
  prepared: InternalizeEdits;
  readiness: OperatorPlanReadiness;
  report: PackageReport;
  saved: InternalizeSymbolPlan;
  site: Site;
  workspace: WorkspaceState;
}

interface ScanClock {
  ms: number;
}

async function writeVerified(context: WriteContext): Promise<ApplyResult> {
  const { base, loaded, options, readiness, site, workspace } = context;
  const elapsed = { ms: 0 };
  const scanClock: ScanClock = { ms: 0 };
  const { journaled, mutation } = await mutateJournaled(
    context,
    elapsed,
    scanClock
  );
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
    discardStaged(workspace);
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
  const scan = await publishAfterWrite(workspace, options, scanClock);
  if (scan.status === "published") {
    deleteLoadedRecord(planRecordFile(workspace, site.planId), loaded);
    deleteJournal(workspace);
  }
  return { ...written, scan, status: "applied" };
}

async function mutateJournaled(
  {
    config,
    options,
    readiness,
    report,
    saved,
    site,
    workspace,
    prepared,
  }: WriteContext,
  elapsed: { ms: number },
  scanClock: ScanClock
): Promise<{ journaled: boolean; mutation: MutationResult }> {
  const runner = options.runner ?? spawnRunner;
  const interrupts = watchInterrupts(options.signals ?? process);
  let journaled = false;
  let applied = false;
  try {
    const mutation = await applyReductionPlan(saved, {
      afterChecks: () =>
        commandChecks(readiness, workspace.root, runner, interrupts, elapsed),
      analyzeAfter: async () => {
        await interrupts.check();
        let after: PackageReport;
        try {
          after = await stagedReport(
            workspace,
            config,
            saved.target.package,
            options.onProgress,
            scanClock
          );
        } catch (error) {
          await interrupts.check();
          throw error;
        }
        await interrupts.check();
        return after;
      },
      before: report,
      beforeWrite: async (files) => {
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
        await interrupts.check();
      },
      expectedHashes: new Map(
        readiness.rollback.files.map((f) => [f.file, f.hash])
      ),
      prepared,
      root: workspace.root,
      write: true,
    });
    applied = mutation.status === "applied";
    if (applied) {
      await interrupts.check();
    }
    return { journaled, mutation };
  } catch (error) {
    discardStaged(workspace);
    throw undone(workspace, error, { applied, journaled });
  } finally {
    interrupts.stop();
  }
}

function undone(
  workspace: WorkspaceState,
  error: unknown,
  { applied, journaled }: { applied: boolean; journaled: boolean }
): unknown {
  if (error instanceof RestoreError) {
    return journaled ? withJournalAdvice(error, workspace) : error;
  }
  const journal = applied ? readJournal(workspace) : undefined;
  if (journal !== undefined) {
    restoreJournaled(workspace, journal, error);
  }
  if (journaled) {
    deleteJournal(workspace);
  }
  return error;
}

async function stagedReport(
  workspace: WorkspaceState,
  config: SemanticsConfig,
  name: string,
  onProgress: ((event: ScanProgressEvent) => void) | undefined,
  scanClock: ScanClock
): Promise<PackageReport> {
  const started = performance.now();
  try {
    const staged = await stageAfterWrite(workspace, config, onProgress);
    return await datasetReader(fileTransport(staged)).packageReport(name);
  } catch (error) {
    throw new Error(
      `The scan after the write failed, so Spyglass restores every file it wrote: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error }
    );
  } finally {
    scanClock.ms += performance.now() - started;
  }
}

async function publishAfterWrite(
  workspace: WorkspaceState,
  options: ApplyRecordOptions,
  scanClock: ScanClock
): Promise<ApplyScan> {
  const publish = options.publish ?? publishStaged;
  const started = performance.now();
  const durationMs = () =>
    Math.round(scanClock.ms + performance.now() - started);
  try {
    await publish(workspace);
    return {
      durationMs: durationMs(),
      output: workspace.output,
      status: "published",
    };
  } catch (error) {
    discardStaged(workspace);
    return {
      durationMs: durationMs(),
      error: error instanceof Error ? error.message : String(error),
      output: workspace.output,
      status: "failed",
    };
  }
}

export async function applyRecord(
  root: string,
  site: Site,
  options: ApplyRecordOptions = {}
): Promise<ApplyResult> {
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
    const currency = await datasetCurrency(
      workspace.root,
      await reader.manifest(),
      config
    );
    if (currency !== "current") {
      return refused({
        kind: "stale-dataset",
        reason: currency === "stale" ? STALE_DATASET : UNRECORDED_DATASET,
      });
    }
    const { report, saved, verdict, execution } = await authorizeSite(
      reader,
      workspace,
      site,
      config.rules,
      options.runner
    );
    const written = [
      ...new Set([
        ...saved.publicRoutes.map((route) => route.file),
        ...saved.plannedChanges
          .filter((change) => change.kind === "rewrite-import")
          .map((change) => change.file),
      ]),
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
    const prepared = execution.mutation;
    if (prepared === undefined) {
      return stop({
        kind: "not-executable",
        reason: "The execution plan has no compiled source edits.",
      });
    }
    const parts = movedParts(loaded.record, verdict.record);
    if (parts.length > 0) {
      return stop({ kind: "authorization-changed", parts });
    }
    const rollback = rollbackRefusal(verdict.readiness, written);
    if (rollback !== undefined) {
      return stop({ kind: "rollback", reason: rollback });
    }
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
        prepared,
        readiness: verdict.readiness,
        report,
        saved,
        site,
        workspace,
      });
    }
    const mutation = await applyReductionPlan(saved, {
      before: report,
      prepared,
      root: workspace.root,
    });
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
