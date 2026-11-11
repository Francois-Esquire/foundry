import "./coverage.css";
import { useMemo } from "react";
import {
  type CompositionRow,
  compositionRows,
  scopeKey,
} from "~/library/composition";
import type { FaceCoverage } from "~/library/face-coverage";
import { useLanguageData } from "~/library/use-face";
import { type DataColumn, DataTable } from "~/ui/content/data-table";
import { TitleBlock, TitleBlockItem } from "~/ui/content/title-block";
import { Notice } from "~/ui/controls/notice";
import { ProgressLine } from "~/ui/controls/progress-line";
import { faceTotals, languageCoverage } from "./statistics";

const tally = (
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
  tally("In the face", "covered", (row) => row.covered),
  tally("In Unicode", "total", (row) => row.total),
  tally("Source", "source", (row) => row.counts.source),
  tally("Edited", "edited", (row) => row.counts.edited),
  tally("Added", "added", (row) => row.counts.added),
  tally("Candidates", "candidates", (row) => row.counts.candidate),
  tally("Missing", "missing", (row) => row.counts.missing),
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
  const data = useLanguageData();
  const languages = data.status === "loaded" ? data.languages : undefined;
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
  const waiting =
    data.status === "unavailable" ? (
      <Notice tone="problem">
        The language data did not load, so coverage cannot be counted by writing
        system or by language. Reload the page to try again.
      </Notice>
    ) : (
      <ProgressLine label="Reading the language data" />
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
        waiting
      )}
    </div>
  );
}
