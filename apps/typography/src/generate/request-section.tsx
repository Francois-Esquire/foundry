import type { Face } from "~/typeface/face";
import { Notice } from "~/ui/controls/notice";
import type { Language } from "~/unicode/languages";
import { emptyReason, noRuleNote } from "./request-draft";
import { RequestFields } from "./request-fields";
import { type RequestPlan, RUN_LIMIT } from "./request-plan";
import type { Draft } from "./session";
import { TargetTable } from "./target-table";

interface PlannedTargetsProps {
  readonly draft: Draft;
  readonly face: Face;
  readonly noRule: number;
  readonly plan: RequestPlan;
}

/** The plan of a request: what kind of test it is, what was left for later, and every target. */
function PlannedTargets({ draft, face, noRule, plan }: PlannedTargetsProps) {
  if (plan.targets.length === 0) {
    return <p data-no-rule={noRule}>{emptyReason(draft, noRule)}</p>;
  }
  return (
    <>
      {noRule > 0 ? (
        <Notice>
          <span data-no-rule={noRule}>{noRuleNote(noRule)}</span>
        </Notice>
      ) : null}
      {plan.heldOut.length > 0 ? (
        <Notice>
          {plan.heldOut.length === 1
            ? "1 of these characters is"
            : `${plan.heldOut.length} of these characters are`}{" "}
          already in the face. This is a holdout test: each is drawn without
          reading the face's own glyph, then compared with it.
        </Notice>
      ) : null}
      {plan.deferred > 0 ? (
        <Notice>
          One run takes {RUN_LIMIT} characters. These are the first {RUN_LIMIT}{" "}
          of {RUN_LIMIT + plan.deferred}; the others wait for the next run.
        </Notice>
      ) : null}
      <TargetTable face={face} plan={plan} />
    </>
  );
}

interface RequestSectionProps {
  readonly draft: Draft;
  readonly face: Face;
  /** Undefined while the language data loads. */
  readonly languages: readonly Language[] | undefined;
  /** Missing characters the procedural strategy is not asked for: no rule builds them. */
  readonly noRule: number;
  readonly onDraft: (patch: Partial<Draft>) => void;
  readonly plan: RequestPlan;
  /** True when a recorded run is chosen, which draws what it drew. */
  readonly replaying: boolean;
}

/** What to generate: the face, where the characters come from, and the targets with their dependencies. */
export function RequestSection({
  draft,
  face,
  languages,
  noRule,
  onDraft,
  plan,
  replaying,
}: RequestSectionProps) {
  return (
    <div className="ty-generate-stack">
      <RequestFields
        draft={draft}
        face={face}
        languages={languages}
        onDraft={onDraft}
        replaying={replaying}
      />
      {replaying ? (
        <Notice>
          A recorded run draws the glyphs it drew when it was made. The choice
          of characters applies to the other strategies.
        </Notice>
      ) : (
        <PlannedTargets draft={draft} face={face} noRule={noRule} plan={plan} />
      )}
    </div>
  );
}
