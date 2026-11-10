import { useMemo } from "react";
import type { StyleCheck } from "~/generation/evaluation/evaluation";
import { type DataColumn, DataTable } from "~/ui/content/data-table";
import {
  defectLines,
  formatMeasure,
  formatScore,
  hasAgreement,
  VERDICT_NAMES,
} from "./evaluation-report";
import type { ReviewedCandidate } from "./session";

const COLUMNS: readonly DataColumn<StyleCheck>[] = [
  { cell: (check) => check.name, header: "Check", id: "name", kind: "label" },
  {
    cell: (check) => formatMeasure(check.measured, check.tolerance),
    header: "Measured",
    id: "measured",
    kind: "numeric",
  },
  {
    cell: (check) => formatMeasure(check.expected, check.tolerance),
    header: "In the face",
    id: "expected",
    kind: "numeric",
  },
  {
    cell: (check) => formatMeasure(check.tolerance, check.tolerance),
    header: "Allowed",
    id: "tolerance",
    kind: "numeric",
  },
  {
    cell: (check) => (check.pass ? "Within" : "Outside"),
    header: "Result",
    id: "result",
    kind: "text",
  },
];

const checkKey = (check: StyleCheck) => check.name;

interface EvaluationPanelProps {
  /** Why the glyph was not compared with the face's own, when it was not. */
  readonly notCompared: string;
  readonly reviewed: ReviewedCandidate;
}

/**
 * One candidate's evaluation: the verdict, the agreement with the face's own
 * glyph under a holdout test, every measured value, and the defects with the
 * ones refinement corrected.
 */
export function EvaluationPanel({
  notCompared,
  reviewed,
}: EvaluationPanelProps) {
  const { corrections, evaluation, first, target } = reviewed;
  const defects = useMemo(
    () => defectLines(first, evaluation, corrections),
    [corrections, evaluation, first]
  );
  const corrected = defects.filter((line) => line.state === "corrected").length;
  const remaining = defects.length - corrected;
  return (
    <div className="ty-generate-evaluation">
      <p className="ty-generate-verdict" data-verdict={evaluation.verdict}>
        <span className="ty-label ty-generate-tag">
          {VERDICT_NAMES[evaluation.verdict]}
        </span>
        <span>
          {defects.length === 0
            ? "No defects found."
            : `${corrected} corrected, ${remaining} left for a person.`}
        </span>
      </p>
      {hasAgreement(evaluation) ? (
        <p
          className="ty-generate-agreement"
          data-agreement={formatScore(evaluation.scores.shape)}
        >
          <span className="ty-label">Agreement</span>{" "}
          {formatScore(evaluation.scores.shape)} with the face's own glyph after
          aligning the two
          {evaluation.scores.shapeInPlace === undefined
            ? ""
            : `, ${formatScore(evaluation.scores.shapeInPlace)} where they stand`}
          . 1 is the same shape. The ink outline is the face's own glyph.
        </p>
      ) : (
        <p className="ty-generate-agreement">
          <span className="ty-label">Agreement</span> Not measured.{" "}
          {notCompared}
        </p>
      )}
      {evaluation.styleChecks.length > 0 ? (
        <DataTable
          caption={`Measured values of ${target.name} against the face`}
          columns={COLUMNS}
          rowKey={checkKey}
          rows={evaluation.styleChecks}
        />
      ) : (
        <p>No style measurement applies to this glyph.</p>
      )}
      {defects.length > 0 ? (
        <ul className="ty-generate-defects">
          {defects.map((line) => (
            <li data-state={line.state} key={`${line.state}:${line.detail}`}>
              <span className="ty-label ty-generate-tag">
                {line.state === "corrected" ? "Corrected" : "Remains"}
              </span>
              <span>
                {line.detail}
                {line.fix ? ` Refinement: ${line.fix}.` : ""}
              </span>
            </li>
          ))}
        </ul>
      ) : null}
      <p>
        <span className="ty-label">Made by</span> {evaluation.madeBy}
      </p>
      {evaluation.weaknesses.map((weakness) => (
        <p key={weakness}>
          <span className="ty-label">Known weakness</span> {weakness}
        </p>
      ))}
    </div>
  );
}
