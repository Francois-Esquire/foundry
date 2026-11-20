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

const OPPORTUNITY_PREFIX = "internalize-symbol:";
const PLAN_PREFIX = `plan:${OPPORTUNITY_PREFIX}`;

function withoutPrefix(word: string, prefixes: readonly string[]): string {
  const prefix = prefixes.find((candidate) => word.startsWith(candidate));
  return prefix === undefined ? word : word.slice(prefix.length);
}

function symbolParts(place: string): [file: string, name: string] | undefined {
  const hash = place.indexOf("#");
  const file = place.slice(0, hash);
  const name = place.slice(hash + 1);
  if (hash <= 0 || name === "" || name.includes("#") || place.includes(":")) {
    return;
  }
  return [file, name];
}

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

export function planRecordFile(
  workspace: WorkspaceState,
  planId: string
): string {
  return join(workspace.directory, "plans", `${hash16(planId)}.json`);
}

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
  runner?: ReadinessCommandRunner;
  state?: string | undefined;
}

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

export async function planSite(
  root: string,
  site: Site,
  options: PlanSiteOptions = {}
): Promise<PlanSiteResult> {
  const { reader, workspace } = await savedDataset(root, options.state);
  refuseUnfinishedApply(workspace);
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
