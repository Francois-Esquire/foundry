import { createHash } from "node:crypto";

import type {
  FoldPackagePlan,
  InternalizeSymbolPlan,
  PlanPrecondition,
  PlanValidation,
  ReductionPlan,
  SurfaceReport,
} from "./types";

// Plan validation: a plan captures facts at analysis time; between planning
// and action those facts may move. Validation re-checks every assumption
// against a fresh analysis of the same target — a failed assumption or a
// fingerprint mismatch makes the plan stale, never applicable.

/**
 * Stable hash of the input facts a plan was built from. Derived claims
 * (predictedDelta, prose descriptions) and positional detail (line numbers)
 * are deliberately excluded: the fingerprint answers "are the facts the
 * same?", not "is the output byte-identical?".
 */
export function planFingerprint(
  plan:
    | Omit<InternalizeSymbolPlan, "fingerprint">
    | Omit<FoldPackagePlan, "fingerprint">
): string {
  const facts =
    plan.operation === "internalize-symbol"
      ? {
          blockers: plan.blockers.map((blocker) => blocker.reason),
          changes: plan.plannedChanges.map((change) => ({
            file: change.file,
            kind: change.kind,
          })),
          operation: plan.operation,
          routes: plan.publicRoutes.map((route) => ({
            chain: route.chain,
            entrypoint: route.entrypoint,
            exportedName: route.exportedName,
            file: route.file,
            kind: route.kind,
            statement: route.statement ?? null,
          })),
          status: plan.status,
          subject: { id: plan.subject.id, name: plan.subject.name },
          target: plan.target,
        }
      : {
          blockers: plan.blockers.map((blocker) => blocker.reason),
          boundaryUsage: plan.boundaryUsage,
          consumedSurface: plan.consumedSurface.map((usage) => ({
            importSites: usage.importSites,
            references: usage.references,
            symbolName: usage.symbolName,
            usageNamespace: usage.usageNamespace,
          })),
          dependencyEdges: plan.dependencyEdges,
          destination: plan.destination,
          files: plan.files,
          metadata: plan.packageMetadata.map((impact) => ({
            file: impact.file,
            kind: impact.kind,
          })),
          operation: plan.operation,
          potentiallyInternalized: plan.potentiallyInternalized,
          source: plan.source,
          status: plan.status,
        };
  return createHash("sha256")
    .update(JSON.stringify(facts))
    .digest("hex")
    .slice(0, 16);
}

function precondition(
  fact: string,
  expected: string | number | boolean,
  actual: string | number | boolean
): PlanPrecondition {
  return { actual, expected, fact, holds: expected === actual };
}

function freshCounterpart(
  plan: ReductionPlan,
  report: SurfaceReport
): ReductionPlan | undefined {
  return report.plans.find((candidate) =>
    plan.operation === "internalize-symbol"
      ? candidate.operation === "internalize-symbol" &&
        candidate.subject.id === plan.subject.id
      : candidate.operation === "fold-package" &&
        candidate.source.package === plan.source.package
  );
}

function internalizePreconditions(
  plan: InternalizeSymbolPlan,
  report: SurfaceReport,
  fresh: ReductionPlan | undefined
): PlanPrecondition[] {
  const symbol = report.symbols.find((entry) => entry.id === plan.subject.id);
  return [
    precondition("symbol still resolves", true, symbol !== undefined),
    precondition(
      "symbol still package-public",
      true,
      symbol?.packagePublic ?? false
    ),
    precondition("external references", 0, symbol?.externalReferences ?? -1),
    precondition("external import sites", 0, symbol?.externalImportSites ?? -1),
    precondition(
      "external consumers",
      0,
      symbol?.consumerPackages.length ?? -1
    ),
    precondition("plan still derivable", true, fresh !== undefined),
  ];
}

function foldPreconditions(
  plan: FoldPackagePlan,
  report: SurfaceReport,
  fresh: ReductionPlan | undefined
): PlanPrecondition[] {
  const primary = report.dependencies.incoming[0]?.package ?? "none";
  return [
    precondition("fold opportunity still exists", true, fresh !== undefined),
    precondition(
      "single consumer gate",
      1,
      report.dependencies.consumerPackages
    ),
    precondition("primary consumer", plan.destination.package, primary),
    precondition(
      "destination unchanged",
      plan.destination.package,
      fresh?.operation === "fold-package" ? fresh.destination.package : "none"
    ),
  ];
}

/**
 * Re-check a plan's assumptions against a fresh analysis of the same target.
 * Ready only when every precondition holds and the freshly rebuilt plan has
 * the identical fingerprint; moved facts yield "stale", and a fresh plan that
 * is itself blocked/unsupported yields that status.
 */
export function validateReductionPlan(
  plan: ReductionPlan,
  report: SurfaceReport
): PlanValidation {
  const fresh = freshCounterpart(plan, report);
  const preconditions =
    plan.operation === "internalize-symbol"
      ? internalizePreconditions(plan, report, fresh)
      : foldPreconditions(plan, report, fresh);

  const base = {
    fingerprint: plan.fingerprint,
    preconditions,
    ...(fresh !== undefined && { currentFingerprint: fresh.fingerprint }),
  };
  const failed = preconditions.filter((entry) => !entry.holds);
  if (fresh === undefined || failed.length > 0) {
    return {
      blockers: failed.map((entry) => ({
        detail: `${entry.fact}: expected ${String(entry.expected)}, found ${String(entry.actual)}.`,
        reason: "stale-plan",
      })),
      status: "stale",
      ...base,
    };
  }
  if (fresh.fingerprint !== plan.fingerprint) {
    return {
      blockers: [
        {
          detail:
            "The facts behind the plan changed since analysis; rebuild the plan from a fresh report.",
          reason: "stale-plan",
        },
      ],
      status: "stale",
      ...base,
    };
  }
  return { blockers: fresh.blockers, status: fresh.status, ...base };
}
