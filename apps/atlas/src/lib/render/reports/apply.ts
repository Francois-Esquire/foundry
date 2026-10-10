import type { ApplyRefusal, ApplyResult, MovedPart } from "../../codemod-types";
import type { RenderDensity } from "../context";
import type { BlockView, ReportView, SectionView, Tone } from "../views";
import { AUTHORIZATION_WORDS } from "./codemod";
import { listSection } from "./ranked-section";

const PLAN_PREFIX = /^plan:/;

/** The opportunity a saved plan's id names, as the commands take it. */
function opportunityOf(planId: string): string {
  return planId.replace(PLAN_PREFIX, "");
}

/** A moved part as the refusal names it; the sources with their files. */
function partText({ files, part }: MovedPart): string {
  if (part === "atlas-version") {
    return "the Atlas that made the record";
  }
  return files === undefined || files.length === 0
    ? part
    : `${part} (${files.join(", ")})`;
}

/** What a refusal says, and what to run next. */
function refusalBlock(refusal: ApplyRefusal, planId: string): BlockView {
  const again = `Run atlas plan ${opportunityOf(planId)} again.`;
  const signal = (title: string, summary: string, tone: Tone = "blocked") =>
    ({ kind: "signal", summary, title, tone }) as const;
  switch (refusal.kind) {
    case "pending-write":
      return refusal.phase === "writing"
        ? signal(
            "An earlier apply was interrupted",
            `The apply of ${refusal.site} stopped while it wrote; Atlas restored ${(refusal.restored ?? []).join(", ")}. Run atlas apply again.`,
            "caution"
          )
        : signal(
            "An earlier apply waits for a scan",
            `The apply of ${refusal.site} wrote and verified its change, but the scan after it did not publish. Run atlas scan.`,
            "caution"
          );
    case "refused-by-rule":
      return signal(
        "Refused by the rules",
        `No rule in the configuration permits it now. Declare one under rules in .foundry/atlas/, then ${again.toLowerCase()}`
      );
    case "not-executable":
      return signal(
        "Not executable",
        `No mutator executes it: ${refusal.reason}.`
      );
    case "readiness":
      return signal(
        AUTHORIZATION_WORDS[refusal.readiness.authorization],
        `Readiness did not authorize it now, with ${refusal.readiness.blockers.length} blocker(s). ${again}`
      );
    case "authorization-changed":
      return signal(
        "Changed since the plan",
        `What atlas plan authorized has moved: ${refusal.parts.map(partText).join(", ")}. ${again}`
      );
    case "rollback":
      return signal(
        "No complete rollback",
        `Atlas would not write: ${refusal.reason}.`
      );
    case "dirty":
      return signal(
        "Uncommitted changes",
        `A file it writes has uncommitted changes: ${refusal.files.join(", ")}. Commit or stash them, then run atlas plan and atlas apply again.`
      );
    case "no-git":
      return signal("No Git", refusal.reason);
    default:
      return signal(
        `The saved plan is ${refusal.status}`,
        `The mutator's own fresh analysis disagrees with the saved plan. Run atlas scan, then ${again.toLowerCase()}`
      );
  }
}

/** The outcome: a preview, a refusal, a write and its scan, or a rollback. */
function outcomeBlock(result: ApplyResult): BlockView {
  const opportunity = opportunityOf(result.planId);
  switch (result.status) {
    case "preview":
      return {
        kind: "signal",
        summary: `Nothing was written. Run atlas apply ${opportunity} --write to write the change, verify it, and scan again.`,
        title: "Preview",
        tone: "emphasis",
      };
    case "rolled-back":
      return {
        kind: "signal",
        summary:
          "A check failed after the write, and every file Atlas wrote was restored.",
        title: "Rolled back",
        tone: "blocked",
      };
    case "applied":
      return result.scan?.status === "published"
        ? {
            kind: "signal",
            summary: `The change is written and verified, and the dataset is saved again to ${result.scan.output}.`,
            title: "Applied",
            tone: "emphasis",
          }
        : {
            kind: "signal",
            summary: `The change is written and verified, but the scan after it failed${result.scan?.error === undefined ? "" : `: ${result.scan.error}`}. The sources hold the change; run atlas scan.`,
            title: "Applied; the scan failed",
            tone: "caution",
          };
    default:
      return result.refusal === undefined
        ? { kind: "signal", title: "Refused", tone: "blocked" }
        : refusalBlock(result.refusal, result.planId);
  }
}

/** Readiness's blockers or the fresh plan's, when the refusal carries them. */
function refusalDetails(
  refusal: ApplyRefusal | undefined,
  density: RenderDensity
): SectionView[] {
  if (refusal?.kind === "readiness") {
    const section = listSection(
      refusal.readiness.blockers.map((b) => `${b.kind}: ${b.detail}`),
      density,
      "Blockers"
    );
    return section === undefined ? [] : [section];
  }
  if (refusal?.kind === "revalidation") {
    const section = listSection(
      refusal.blockers.map((b) => `${b.reason}: ${b.detail}`),
      density,
      "Blockers"
    );
    return section === undefined ? [] : [section];
  }
  return [];
}

/**
 * `atlas apply`: the outcome, each statement the mutator edits, before and
 * after, and, after a write, every check it passed or failed.
 */
export function buildApplyView(
  result: ApplyResult,
  density: RenderDensity
): ReportView {
  const edits = listSection(
    result.edits.map(
      (edit) => `${edit.file}: ${edit.before} → ${edit.after ?? "(removed)"}`
    ),
    density,
    result.status === "preview" ? "Edits it would make" : "Edits"
  );
  const checks = listSection(
    (result.verification?.checks ?? []).map(
      (check) => `${check.status} · ${check.check}: ${check.detail}`
    ),
    density,
    "Checks after the write"
  );
  const sections: SectionView[] = [
    {
      blocks: [
        {
          kind: "labelValue",
          rows: [
            { label: "Opportunity", value: opportunityOf(result.planId) },
            { label: "Mode", value: result.mode },
          ],
        },
        outcomeBlock(result),
      ],
    },
    ...refusalDetails(result.refusal, density),
    ...(edits === undefined ? [] : [edits]),
    ...(checks === undefined ? [] : [checks]),
  ];
  return {
    sections,
    title: `${result.mode === "write" ? "Apply" : "Preview of"} ${result.site}`,
  };
}
