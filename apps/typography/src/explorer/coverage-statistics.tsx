import "./coverage.css";
import { useMemo } from "react";
import {
  type CompositionRow,
  compositionRows,
  scopeKey,
} from "~/library/composition";
import type { FaceCoverage } from "~/library/face-coverage";
import { useLanguages } from "~/library/use-face";
import { type DataColumn, DataTable } from "~/ui/content/data-table";
import { TitleBlock, TitleBlockItem } from "~/ui/content/title-block";
import { ProgressLine } from "~/ui/controls/progress-line";
import { faceTotals, languageCoverage } from "./statistics";

const count = (
  header: string,
  id: string,
  read: (row: CompositionRow) => number
): DataColumn<CompositionRow> => ({
  cell: (row) => read(row),
  header,
  id,
  kind: "numeric",
});

const COLUMNS: readonly DataColumn<CompositionRow>[] = [
  {
    cell: (row) => row.name,
    header: "Writing system",
    id: "name",
    kind: "label",
  },
  {
    cell: (row) => `${row.percent.toFixed(1)}%`,
    header: "Share",
    id: "share",
    kind: "numeric",
  },
  count("In the face", "covered", (row) => row.covered),
  count("In Unicode", "total", (row) => row.total),
  count("Source", "source", (row) => row.counts.source),
  count("Edited", "edited", (row) => row.counts.edited),
  count("Added", "added", (row) => row.counts.added),
  count("Candidates", "candidates", (row) => row.counts.candidate),
  count("Missing", "missing", (row) => row.counts.missing),
];

const rowKey = (row: CompositionRow) => scopeKey(row.scope);

/**
 * Coverage in numbers: the face overall, each writing system it touches, and
 * the languages whose required characters it holds.
 */
export function CoverageStatistics({
  coverage,
}: {
  readonly coverage: FaceCoverage;
}) {
  const languages = useLanguages();
  const totals = useMemo(() => faceTotals(coverage.classification), [coverage]);
  const rows = useMemo(
    () =>
      languages && compositionRows(coverage.byScope, languages, coverage.has),
    [coverage, languages]
  );
  const supported = useMemo(
    () => languages && languageCoverage(languages, coverage.has),
    [coverage, languages]
  );
  return (
    <div className="ty-coverage-statistics">
      <TitleBlock>
        <TitleBlockItem label="Characters in the face">
          {totals.covered}
        </TitleBlockItem>
        <TitleBlockItem label="From the source, unchanged">
          {totals.counts.source}
        </TitleBlockItem>
        <TitleBlockItem label="Edited">{totals.counts.edited}</TitleBlockItem>
        <TitleBlockItem label="Added">{totals.counts.added}</TitleBlockItem>
        <TitleBlockItem label="Candidates, not accepted">
          {totals.counts.candidate}
        </TitleBlockItem>
      </TitleBlock>
      {rows && supported ? (
        <>
          <DataTable
            caption="Coverage by writing system"
            columns={COLUMNS}
            rowKey={rowKey}
            rows={rows}
          />
          <div className="ty-coverage-languages">
            <h3 className="ty-heading">Languages</h3>
            <p className="ty-lede">
              {supported.complete} of {supported.known} languages with character
              data have every required character in this face. That counts
              characters only: a language is supported once its shaping has been
              proved in text.
            </p>
            <dl>
              {supported.byScript.map((group) => (
                <div key={group.script}>
                  <dt className="ty-label">
                    {group.script}, {group.languages.length}
                  </dt>
                  <dd>{group.languages.join(", ")}</dd>
                </div>
              ))}
            </dl>
          </div>
        </>
      ) : (
        <ProgressLine label="Reading the language data" />
      )}
    </div>
  );
}
