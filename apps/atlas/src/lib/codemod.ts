import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { isMissingPath, writeFileAtomicSync } from "@foundry/lib/atomic-file";
import { applyReductionPlan, DIRTY_DETAIL } from "./apply";
import { createOperatorContext } from "./architectural-operator";
import { loadConfiguration } from "./atlas-config";
import type {
  ApplyRefusal,
  ApplyResult,
  MovedPart,
  PlanSiteResult,
  Site,
} from "./codemod-types";
import type { DatasetReader, PackageReport } from "./dataset";
import { savedDataset } from "./dataset-files";
import { executionPlanFor } from "./execution-plan";
import { createOperatorPlanningContext } from "./operator-planning-context";
import type {
  MutationAuthorizationResult,
  ReadinessCommandRunner,
} from "./operator-readiness";
import { authorizeMutationPlan } from "./operator-readiness";
import type {
  AuthorizedMutationPlan,
  OperatorPlanReadiness,
} from "./operator-readiness-types";
import { AUTHORIZED_MUTATION_PLAN_SCHEMA_VERSION } from "./operator-readiness-types";
import type { Rule } from "./rule-declaration";
import { hash16 } from "./short-hash";
import type { WorkspaceState } from "./state";
import { lockState } from "./state";
import type { InternalizeSymbolPlan, MutationResult } from "./types";
import { createWorkspaceProjectionContext } from "./workspace-projection";

// `atlas plan` and `atlas apply`: one internalize opportunity through the
// rules, the bridge to its mutator, and readiness. Plan reads the saved
// dataset, takes the rules from its rules lens (no configuration runs), and
// runs readiness's baseline commands; it writes nothing in the workspace,
// only the authorization record in the state directory. Apply never trusts
// that record: under the state lock it loads the configuration's rules,
// authorizes again, fresh, and goes on only when the `auth:` hash is the
// record's, then hands the saved plan to its mutator.

const OPPORTUNITY_PREFIX = "internalize-symbol:";
const PLAN_PREFIX = `plan:${OPPORTUNITY_PREFIX}`;

/** The word without its first matching prefix. */
function withoutPrefix(word: string, prefixes: readonly string[]): string {
  const prefix = prefixes.find((candidate) => word.startsWith(candidate));
  return prefix === undefined ? word : word.slice(prefix.length);
}

/** A symbol facet's file and name, split at its one `#`; undefined for any other shape. */
function symbolParts(place: string): [file: string, name: string] | undefined {
  const hash = place.indexOf("#");
  const file = place.slice(0, hash);
  const name = place.slice(hash + 1);
  // A second `#` is no facet; a `:` left over is another operation's id,
  // such as `fold-package:…`.
  if (hash <= 0 || name === "" || name.includes("#") || place.includes(":")) {
    return;
  }
  return [file, name];
}

/**
 * The site a word names: an opportunity id
 * (`internalize-symbol:<path#name>`), a saved plan's id
 * (`plan:internalize-symbol:<path#name>`), or the bare `path#name`. Any other
 * shape throws; whether the site exists is the dataset's to say.
 */
export function resolveSite(word: string): Site {
  const place = withoutPrefix(word, [PLAN_PREFIX, OPPORTUNITY_PREFIX]);
  if (symbolParts(place) === undefined) {
    throw new Error(
      `${word} names no internalize opportunity. Write internalize-symbol:<path#name>, its plan id, or <path#name>.`
    );
  }
  const opportunity = `${OPPORTUNITY_PREFIX}${place}`;
  return { opportunity, place, planId: `plan:${opportunity}` };
}

/**
 * The journal an `atlas apply` keeps while it writes (3.5): while it exists,
 * the sources may hold a write the dataset does not describe.
 */
function applyJournal(workspace: WorkspaceState): string {
  return join(workspace.directory, "apply", "journal.json");
}

/**
 * Refuses while an apply's journal exists. Only whether it exists is read
 * here; 3.5 reads its phase to say whether to restore or to scan.
 */
function refuseUnfinishedApply(workspace: WorkspaceState): void {
  const journal = applyJournal(workspace);
  if (existsSync(journal)) {
    throw new Error(
      `An atlas apply did not finish (${journal} exists), so the saved dataset may not describe the sources. Run atlas apply to restore an interrupted write, or atlas scan after one that verified.`
    );
  }
}

/** Where the authorization record for a saved plan is kept: `<state directory>/plans/<digest>.json`. */
export function planRecordFile(
  workspace: WorkspaceState,
  planId: string
): string {
  return join(workspace.directory, "plans", `${hash16(planId)}.json`);
}

/** The saved plan for a site and its package's report, found through the module index; an unknown site throws. */
async function savedPlanOf(
  reader: DatasetReader,
  site: Site
): Promise<{ report: PackageReport; saved: InternalizeSymbolPlan }> {
  const [file] = symbolParts(site.place) ?? [site.place];
  const index = await reader.moduleIndex();
  const module = index.modules.find((entry) => entry.id === file);
  if (module === undefined) {
    throw new Error(
      `${file} is not a module of the saved dataset. Check the path, or run atlas scan if the file is new.`
    );
  }
  const report = await reader.packageReport(module.package);
  if (!report.opportunities.some((o) => o.id === site.opportunity)) {
    throw new Error(
      `${module.package} records no opportunity ${site.opportunity}. atlas report ${module.package} lists its opportunities.`
    );
  }
  const saved = report.plans.find(
    (candidate): candidate is InternalizeSymbolPlan =>
      candidate.operation === "internalize-symbol" &&
      candidate.id === site.planId
  );
  if (saved === undefined) {
    throw new Error(`${module.package} holds no saved plan ${site.planId}.`);
  }
  return { report, saved };
}

export interface PlanSiteOptions {
  /** Runs readiness's baseline commands; by default they are spawned. */
  runner?: ReadinessCommandRunner;
  state?: string | undefined;
}

/** The chain for one site, as plan and apply both run it: the saved plan, and `authorizeMutationPlan`'s answer under `rules`. */
async function authorizeSite(
  reader: DatasetReader,
  workspace: WorkspaceState,
  site: Site,
  rules: readonly Rule[],
  runner: ReadinessCommandRunner | undefined
): Promise<{
  saved: InternalizeSymbolPlan;
  verdict: MutationAuthorizationResult;
}> {
  const { report, saved } = await savedPlanOf(reader, site);
  // Internalize edits its own package only, so only its report and its
  // package are read.
  const facts = createOperatorContext(
    createWorkspaceProjectionContext(await reader.workspaceReport()),
    [report]
  );
  const planning = createOperatorPlanningContext({
    packages: [saved.target.package],
    root: workspace.root,
  });
  const { composition, operators, plan } = executionPlanFor(
    facts,
    planning,
    site.planId
  );
  const verdict = authorizeMutationPlan(
    plan,
    {
      composition,
      facts,
      operators,
      planning,
      ...(runner !== undefined && { runner }),
    },
    rules
  );
  return { saved, verdict };
}

/**
 * Plans one site and asks `authorizeMutationPlan` whether its mutator may
 * run, under the rules the saved dataset's rules lens holds. A record exists
 * only while the last plan of its site authorized it: an authorized verdict
 * writes it, atomically and without the state lock, and any other verdict
 * deletes it. Apply never trusts a record: it authorizes again, fresh,
 * before it writes, and refuses unless the `auth:` hash matches.
 */
export async function planSite(
  root: string,
  site: Site,
  options: PlanSiteOptions = {}
): Promise<PlanSiteResult> {
  const { reader, workspace } = await savedDataset(root, options.state);
  refuseUnfinishedApply(workspace);
  const { rules } = await reader.lens("rules");
  const { saved, verdict } = await authorizeSite(
    reader,
    workspace,
    site,
    rules,
    options.runner
  );
  const result: PlanSiteResult = {
    opportunity: site.opportunity,
    plan: saved,
    site: site.place,
    verdict,
  };
  const record = planRecordFile(workspace, site.planId);
  if (verdict.kind !== "authorized") {
    rmSync(record, { force: true });
    return result;
  }
  writeFileAtomicSync(record, `${JSON.stringify(verdict.record, null, 2)}\n`, {
    createDirectory: true,
  });
  return { ...result, record };
}

/** The authorization record `atlas plan` saved for a site; none saved fails, and asks for a plan. */
function loadRecord(
  workspace: WorkspaceState,
  site: Site
): AuthorizedMutationPlan {
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
  return parsed;
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

export interface ApplyRecordOptions {
  /** Runs readiness's baseline commands; by default they are spawned. */
  runner?: ReadinessCommandRunner;
  state?: string | undefined;
}

/**
 * Applies the plan `atlas plan` authorized for a site; in this version, as
 * a preview only: nothing is written. Under the state lock it refuses an
 * unfinished apply, loads the configuration's rules, authorizes the plan
 * again, fresh (running the baseline commands), and goes on only when the
 * fresh record's `auth:` hash and saved plan are the recorded ones, when the
 * rollback can restore every file the mutator writes, and when the mutator's
 * own fresh analysis still agrees with the saved plan.
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
    refuseUnfinishedApply(workspace);
    const recorded = loadRecord(workspace, site);
    const { rules } = await loadConfiguration(workspace.root);
    const { saved, verdict } = await authorizeSite(
      reader,
      workspace,
      site,
      rules,
      options.runner
    );
    const written = [
      ...new Set(saved.publicRoutes.map((route) => route.file)),
    ].sort((a, b) => a.localeCompare(b));
    const base = {
      changedFiles: written,
      edits: [],
      mode: "preview" as const,
      planId: site.planId,
      site: site.place,
    };
    const refused = (why: ApplyRefusal): ApplyResult => ({
      ...base,
      refusal: why,
      status: "refused",
    });
    if (verdict.kind !== "authorized") {
      return refused(verdict);
    }
    const parts = movedParts(recorded, verdict.record);
    if (parts.length > 0) {
      return refused({ kind: "authorization-changed", parts });
    }
    const rollback = rollbackRefusal(verdict.readiness, written);
    if (rollback !== undefined) {
      return refused({ kind: "rollback", reason: rollback });
    }
    // Only a file the mutator writes blocks; any other dirty file stays a
    // caution in the readiness.
    const dirty = verdict.readiness.sourceState.git.plannedDirty.filter(
      (file) => written.includes(file)
    );
    if (dirty.length > 0) {
      return refused({ files: dirty, kind: "dirty" });
    }
    const mutation = await applyReductionPlan(saved, { root: workspace.root });
    const refusal = mutatorRefusal(mutation);
    if (refusal !== undefined) {
      return refused(refusal);
    }
    return {
      ...base,
      changedFiles: mutation.changedFiles,
      edits: mutation.edits ?? [],
      status: "preview",
    };
  } finally {
    release();
  }
}
