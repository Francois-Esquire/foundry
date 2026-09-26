import type { ReductionPlan, SurfaceReport } from "../../types";
import { plural } from "../format";
import type { BlockView } from "../views";
import { blockerPhrase } from "./explanations";

/**
 * The one line to read first. Picks the strongest finding the analysis
 * already made and states where it stands; it never authors advice.
 */
export function verdict(report: SurfaceReport): BlockView {
  const fold = report.opportunities.find(
    (item) => item.operation === "fold-package"
  );
  if (fold !== undefined) {
    const plan = report.plans.find(
      (candidate) =>
        candidate.operation === "fold-package" &&
        candidate.source.package === fold.subject.id
    );
    return {
      kind: "signal",
      summary: foldStatus(plan),
      title: `Behaves as an internal subsystem of ${fold.target?.name ?? "its consumer"}`,
      tone: "emphasis",
    };
  }

  const unused = report.opportunities.filter(
    (item) => item.operation === "internalize-symbol"
  ).length;
  const publicSymbols = report.summary.packagePublicSymbols;
  const consumers = report.dependencies.consumerPackages;
  if (consumers === 0) {
    return {
      kind: "signal",
      title: "No workspace package consumes this one",
      tone: "emphasis",
      ...(unused > 0 && { summary: internalizeStatus(report) }),
    };
  }
  if (unused > 0) {
    return {
      kind: "signal",
      summary: internalizeStatus(report),
      title: `${unused} of ${plural(publicSymbols, "public symbol")} unused outside the package`,
      tone: "emphasis",
    };
  }
  return {
    kind: "signal",
    title: `All ${plural(publicSymbols, "public symbol")} used outside the package, across ${plural(consumers, "consumer package")}`,
    tone: "emphasis",
  };
}

function foldStatus(plan: ReductionPlan | undefined): string {
  if (plan === undefined) {
    return "Fold candidate; no plan.";
  }
  if (plan.status === "blocked" || plan.status === "unsupported") {
    return `Fold plan ${plan.status}: ${plan.blockers.map((blocker) => blocker.detail).join(" ")}`;
  }
  const scale = plan.intelligence?.scale;
  return (
    "Fold plan ready" +
    (scale === undefined
      ? "."
      : ` across ${plural(scale.files.total, "file")}.`)
  );
}

function internalizeStatus(report: SurfaceReport): string {
  const plans = report.plans.filter(
    (plan) => plan.operation === "internalize-symbol"
  );
  const byStatus = (status: ReductionPlan["status"]) =>
    plans.filter((plan) => plan.status === status).length;
  const ready = byStatus("ready");
  const blocked = byStatus("blocked");
  const unsupported = byStatus("unsupported");
  const parts = [
    ...(ready > 0 ? [`${ready} plan-ready`] : []),
    ...(blocked > 0 ? [`${blocked} blocked`] : []),
    ...(unsupported > 0 ? [`${unsupported} unsupported`] : []),
  ];
  const reasons = Object.entries(
    report.operators.find((operator) => operator.id === "internalize-export")
      ?.unsupportedReasons ?? {}
  ).sort(([, a], [, b]) => b - a);
  const [top] = reasons;
  if (top === undefined) {
    return `${parts.join(" · ")}.`;
  }
  const [reason, total] = top;
  const shared = total === unsupported;
  const phrase = blockerPhrase(reason) ?? reason;
  return shared
    ? `${parts.join(" · ")}: ${phrase}.`
    : `${parts.join(" · ")} (${reasons.map(([name, n]) => `${name} ${n}`).join(" · ")}).`;
}
