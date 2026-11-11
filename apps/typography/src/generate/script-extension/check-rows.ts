/**
 * A verification report as the rows a person reads: one per check, with how
 * many of its items passed. A check with nothing to run on is "not run",
 * which is never a pass.
 */

import type { VerificationReport } from "~/generation/script-extension/verify";
import { formatCodePoint } from "~/lib/code-point";
import { codePointsOf } from "./plan-rows";

export type CheckOutcome = "fail" | "not-run" | "pass";

export interface CheckRow {
  /** How many items passed, as "9 of 9". Empty when the check has no items. */
  readonly counted: string;
  readonly id: string;
  readonly name: string;
  /** What the figure means, or why the check did not run. */
  readonly note: string;
  readonly outcome: CheckOutcome;
}

type Items = readonly { readonly pass: boolean }[];

const passedOf = (items: Items) => items.filter((item) => item.pass).length;

const counted = (
  id: string,
  name: string,
  items: Items,
  note = ""
): CheckRow =>
  items.length === 0
    ? {
        counted: "",
        id,
        name,
        note: "Did not run. The plan has nothing of this kind to check.",
        outcome: "not-run",
      }
    : {
        counted: `${passedOf(items)} of ${items.length}`,
        id,
        name,
        note,
        outcome: passedOf(items) === items.length ? "pass" : "fail",
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
      "Latin from the source font shapes exactly as before",
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
    .filter((check) => !check.pass)
    .map((check) => `${check.mark} on ${check.base}: ${check.detail}`),
  ...report.headlines
    .filter((check) => !check.pass)
    .map((check) => `${spelled(check.text)}: ${check.gaps.join(" ")}`),
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
