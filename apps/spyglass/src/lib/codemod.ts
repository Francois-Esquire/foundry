import { rmSync } from "node:fs";
import { join } from "node:path";
import { writeFileAtomicSync } from "@foundry/lib/atomic-file";
import { refuseUnfinishedApply } from "./apply-journal";
import { createOperatorContext } from "./architectural-operator";
import type { PlanSiteResult, Site } from "./codemod-types";
import type { DatasetReader, PackageReport } from "./dataset";
import {
  datasetCurrency,
  STALE_DATASET,
  UNRECORDED_DATASET,
} from "./dataset-current";
import { savedDataset } from "./dataset-files";
import { executionPlanFor } from "./execution-plan";
import type { OperatorExecutionPlan } from "./operator-plan-types";
import { createOperatorPlanningContext } from "./operator-planning-context";
import type {
  MutationAuthorizationResult,
  ReadinessCommandRunner,
} from "./operator-readiness";
import { authorizeMutationPlan } from "./operator-readiness";
import type { Rule } from "./rule-declaration";
import { hash16 } from "./short-hash";
import type { WorkspaceState } from "./state";
import type { InternalizeSymbolPlan } from "./types";
import { createWorkspaceProjectionContext } from "./workspace-projection";

// `spyglass plan`, and what `spyglass apply` shares with it: one internalize
// opportunity through the rules, the bridge to its mutator, and readiness.
// Plan reads the saved dataset, takes the rules from its rules lens (no
// configuration runs), and runs readiness's baseline commands; it writes
// nothing in the workspace, only the authorization record in the state
// directory, which apply (`codemod-apply.ts`) never trusts on its own.

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
      `${file} is not a module of the saved dataset. Check the path, or run spyglass scan if the file is new.`
    );
  }
  const report = await reader.packageReport(module.package);
  if (!report.opportunities.some((o) => o.id === site.opportunity)) {
    throw new Error(
      `${module.package} records no opportunity ${site.opportunity}. spyglass report ${module.package} lists its opportunities.`
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

/** The chain for one site, as plan and apply both run it: the saved plan, its package's report, and `authorizeMutationPlan`'s answer under `rules`. */
export async function authorizeSite(
  reader: DatasetReader,
  workspace: WorkspaceState,
  site: Site,
  rules: readonly Rule[],
  runner: ReadinessCommandRunner | undefined
): Promise<{
  report: PackageReport;
  saved: InternalizeSymbolPlan;
  execution: OperatorExecutionPlan;
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
  return { execution: plan, report, saved, verdict };
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
  // Fails early on a dataset that no longer describes the workspace; plan
  // runs no configuration, so the manifest's own config part stands in.
  const currency = await datasetCurrency(
    workspace.root,
    await reader.manifest()
  );
  if (currency !== "current") {
    throw new Error(currency === "stale" ? STALE_DATASET : UNRECORDED_DATASET);
  }
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
