import "./outcome-tag.css";

export type Outcome = "pass" | "fail" | "not-run";

const NAMES: Readonly<Record<Outcome, string>> = {
  fail: "Fail",
  "not-run": "Not run",
  pass: "Pass",
};

interface OutcomeTagProps {
  /** Replaces the standard word, for example "Changed" or "Inconclusive". */
  readonly children?: string;
  readonly outcome: Outcome;
}

/**
 * The result of one check, printed as a tag. A failure is on, so its tag is a
 * filled box; a pass is an outline; a check that did not run has no box at
 * all, so it can never be read as a pass.
 */
export function OutcomeTag({ children, outcome }: OutcomeTagProps) {
  return (
    <span className="ty-label ty-outcome" data-outcome={outcome}>
      {children ?? NAMES[outcome]}
    </span>
  );
}
