import type { PlanSiteResult } from "../../codemod-types";
import type {
  MutationAuthorization,
  OperatorPlanReadiness,
  ReadinessVerificationStep,
} from "../../operator-readiness-types";
import type { RenderDensity } from "../context";
import type { BlockView, ReportView, SectionView, Tone } from "../views";
import { blockerDefinitions } from "./explanations";
import { listSection } from "./ranked-section";

/** How readiness's verdict reads as the plan's title line. */
export const AUTHORIZATION_WORDS: Record<MutationAuthorization, string> = {
  authorized: "Authorized",
  blocked: "Blocked",
  "not-authorized": "Not authorized",
  stale: "Stale",
  unsupported: "Unsupported",
};

/** A contradiction blocks; a stale plan or a missing proof is a caution. */
function readinessTone(authorization: MutationAuthorization): Tone {
  return authorization === "blocked" ? "blocked" : "caution";
}

/** The verdict: what was decided, and what to do about it. */
function verdictBlock(result: PlanSiteResult): BlockView {
  const { verdict } = result;
  switch (verdict.kind) {
    case "authorized":
      return {
        kind: "signal",
        summary: `Permitted by ${verdict.record.permittedBy.map((index) => `rules[${index}]`).join(", ")}. The record is saved to ${result.record}.`,
        title: AUTHORIZATION_WORDS.authorized,
        tone: "emphasis",
      };
    case "refused-by-rule":
      return {
        evidence: verdict.refused.map(
          ({ operator, place = result.site }) =>
            `No rule permits ${operator} on ${place}. Declare { effect: "permit", operator: "${operator}", subject: "${place}" }, or a subject above it, under rules in .foundry/atlas/, then scan again.`
        ),
        kind: "signal",
        title: "Refused by the rules",
        tone: "blocked",
      };
    case "not-executable": {
      // A saved plan that is not ready is the bridge's reason; its status
      // titles the verdict, and its reasons follow.
      const { status } = result.plan;
      if (status !== "ready") {
        return {
          kind: "signal",
          summary: `The saved plan is ${status}; see its reasons below.`,
          title: AUTHORIZATION_WORDS[status],
          tone: "blocked",
        };
      }
      return {
        kind: "signal",
        summary: `No mutator executes it: ${verdict.reason}.`,
        title: "Not executable",
        tone: "blocked",
      };
    }
    default: {
      const { authorization, blockers } = verdict.readiness;
      return {
        kind: "signal",
        summary: `Readiness did not authorize it, with ${blockers.length} blocker(s).`,
        title: AUTHORIZATION_WORDS[authorization],
        tone: readinessTone(authorization),
      };
    }
  }
}

/** The saved plan's blockers, and what each reason means, as the package report defines it. */
function savedBlockers(result: PlanSiteResult): SectionView[] {
  const { blockers, status } = result.plan;
  if (blockers.length === 0) {
    return [];
  }
  const lines = blockerDefinitions(blockers.map((blocker) => blocker.reason));
  const list: BlockView = {
    items: blockers.map((blocker) => `${blocker.reason}: ${blocker.detail}`),
    kind: "list",
  };
  return [
    {
      blocks:
        lines.length === 0
          ? [list]
          : [list, { kind: "note", lines, title: "What the reasons mean" }],
      title: `The saved plan is ${status}`,
    },
  ];
}

/** One verification step: what it checks, over which package, and how. */
function stepLine(step: ReadinessVerificationStep): string {
  const what = `${step.kind} · ${step.scope.join(", ")}`;
  if (step.command !== undefined) {
    const { args, cwd, executable } = step.command;
    return `${what} · ${[executable, ...args].join(" ")} in ${cwd}`;
  }
  return step.mode === "analyzer"
    ? `${what} · checked by Atlas`
    : `${what} · cannot run: ${step.detail ?? "no command"}`;
}

/** Readiness's findings and the verification apply runs, once readiness judged the plan. */
function readinessSections(
  readiness: OperatorPlanReadiness,
  density: RenderDensity
): SectionView[] {
  const sections = [
    listSection(
      readiness.blockers.map((b) => `${b.kind}: ${b.detail}`),
      density,
      "Blockers"
    ),
    listSection(
      readiness.cautions.map((c) => `${c.kind}: ${c.detail}`),
      density,
      "Cautions"
    ),
    listSection(
      readiness.verification.steps.map(stepLine),
      density,
      "Verification apply runs"
    ),
  ];
  return sections.filter((section) => section !== undefined);
}

const nextStep = (result: PlanSiteResult): SectionView => ({
  blocks: [
    {
      kind: "text",
      lines: [
        `Run atlas apply ${result.opportunity} to preview; add --write to write.`,
      ],
    },
  ],
  title: "Next",
});

/**
 * `atlas plan`: the verdict, the planned changes, why the saved plan or
 * readiness stops it, the verification apply runs, and what to run next.
 */
export function buildPlanView(
  result: PlanSiteResult,
  density: RenderDensity
): ReportView {
  const { plan, verdict } = result;
  const changes = listSection(
    plan.plannedChanges.map(
      (change) => `${change.file}: ${change.description}`
    ),
    density,
    "Planned changes"
  );
  const sections: SectionView[] = [
    {
      blocks: [
        {
          kind: "labelValue",
          rows: [
            { label: "Opportunity", value: result.opportunity },
            { label: "Package", value: plan.target.package },
            { label: "Saved plan", value: plan.status },
          ],
        },
        verdictBlock(result),
      ],
    },
    ...(changes === undefined ? [] : [changes]),
    ...savedBlockers(result),
    ...("readiness" in verdict
      ? readinessSections(verdict.readiness, density)
      : []),
    ...(verdict.kind === "authorized" ? [nextStep(result)] : []),
  ];
  return { sections, title: `Plan for ${result.site}` };
}
