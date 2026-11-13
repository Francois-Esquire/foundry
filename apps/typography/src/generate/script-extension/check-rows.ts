/**
 * A verification report as the rows a person reads: one per check, with how
 * many of its items passed. A check with nothing to run on is "not run",
 * which is never a pass.
 */

import type {
  CheckOutcome,
  VerificationReport,
} from "~/generation/script-extension/verify";
import { formatCodePoint } from "~/lib/code-point";
import { codePointsOf } from "./plan-rows";

export interface CheckRow {
  /** How many items passed, as "9 of 9". Empty when the check has no items. */
  readonly counted: string;
  readonly id: string;
  readonly name: string;
  /** What the figure means, or why the check did not run. */
  readonly note: string;
  readonly outcome: CheckOutcome;
}

/** A check that always runs, or a probe that may have had nothing to inspect. */
type Item =
  | { readonly pass: boolean }
  | {
      readonly detail: string;
      readonly outcome: CheckOutcome;
      readonly text: string;
    };

const outcomeOf = (item: Item): CheckOutcome => {
  if ("outcome" in item) {
    return item.outcome;
  }
  return item.pass ? "pass" : "fail";
};

/**
 * One row for a list of checks. It passes only when every one ran and
 * passed: a probe that did not run is named in the note with its reason, and
 * is never counted among the passed.
 */
const counted = (
  id: string,
  name: string,
  items: readonly Item[],
  note = ""
): CheckRow => {
  if (items.length === 0) {
    return {
      counted: "",
      id,
      name,
      note: "Did not run. The plan has nothing of this kind to check.",
      outcome: "not-run",
    };
  }
  const outcomes = items.map(outcomeOf);
  const skipped = items.flatMap((item) =>
    "outcome" in item && item.outcome === "not-run"
      ? [`${item.text}: ${item.detail}`]
      : []
  );
  let outcome: CheckOutcome = skipped.length > 0 ? "not-run" : "pass";
  if (outcomes.includes("fail")) {
    outcome = "fail";
  }
  return {
    counted: `${outcomes.filter((each) => each === "pass").length} of ${items.length}`,
    id,
    name,
    note: [...skipped, note].filter(Boolean).join(" "),
    outcome,
  };
};

const IDENTITY = "Letter identity";

const identityRow = ({ identity }: VerificationReport): CheckRow =>
  identity
    ? counted(
        "identity",
        `${IDENTITY} against ${identity.reference}`,
        identity.letters,
        `Each generated letter agrees most with its own letter in ${identity.reference}. This says which letter was drawn. ${identity.reference} is another design, so it says nothing about style.`
      )
    : {
        counted: "",
        id: "identity",
        name: IDENTITY,
        note: "Did not run. No font with these letters is in the project to compare with. Import one, then verify again.",
        outcome: "not-run",
      };

export const checkRows = (report: VerificationReport): CheckRow[] => {
  const { errors, loadable, warnings } = report.validation;
  return [
    {
      counted: "",
      id: "built",
      name: "The built font loads and validates",
      note: `The engine's validation reports ${errors.length} errors and ${warnings.length} warnings.`,
      outcome: loadable && errors.length === 0 ? "pass" : "fail",
    },
    counted(
      "characters",
      "Characters map to their own glyph",
      report.characters
    ),
    counted(
      "forms",
      "Forms with no character are reached by layout rules",
      report.forms
    ),
    counted("words", "Test words shape to the planned glyphs", report.words),
    counted(
      "marks",
      "Marks have no advance and sit on their base's stem",
      report.marks
    ),
    counted(
      "headlines",
      "Headlines of neighbouring letters meet in the test words",
      report.headlines
    ),
    identityRow(report),
    counted(
      "latin",
      "Tested Latin texts from the source font shape exactly as before",
      report.latin
    ),
  ];
};

const spelled = (text: string) =>
  codePointsOf(text).map(formatCodePoint).join(" ");

/** Every item that failed, in a sentence each. Empty when nothing failed. */
export const failureLines = (report: VerificationReport): string[] => [
  ...report.validation.errors.map((error) => `The built font: ${error}`),
  ...report.characters
    .filter((check) => !check.pass)
    .map(
      (check) =>
        `${formatCodePoint(check.character)} should map to ${check.expected} and maps to ${check.got ?? "no glyph"}.`
    ),
  ...[...report.forms, ...report.words]
    .filter((check) => !check.pass)
    .map(
      (check) =>
        `${spelled(check.text)} should shape to ${check.expected.join(" ")} and shapes to ${check.got.join(" ")}.`
    ),
  ...report.marks
    .filter((check) => check.outcome === "fail")
    .map((check) => `${check.mark} on ${check.base}: ${check.detail}`),
  ...report.headlines
    .filter((check) => check.outcome === "fail")
    .map((check) => `${spelled(check.text)}: ${check.detail}`),
  ...(report.identity?.letters ?? [])
    .filter((letter) => !letter.pass)
    .map(
      (letter) =>
        `${letter.name} agrees ${letter.ownScore.toFixed(2)} with its own letter and ${letter.closestScore.toFixed(2)} with ${letter.closest}.`
    ),
  ...report.latin
    .filter((check) => !check.pass)
    .map(
      (check) =>
        `"${check.text}" no longer shapes as it does in the source font.`
    ),
];
