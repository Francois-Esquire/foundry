import type {
  DerivedFontCheck,
  DerivedFontCheckId,
  DerivedFontReport,
} from "~/packaging/validation";
import { type DataColumn, DataTable } from "~/ui/content/data-table";
import { OutcomeTag } from "./outcome-tag";

const CHECK_NAMES: Readonly<Record<DerivedFontCheckId, string>> = {
  browser: "Browser sanitizer",
  coverage: "Characters asked for",
  engine: "Font engine",
  joining: "Ligatures and conjuncts",
  reopen: "Reopens",
  shaping: "Shaping kept",
};

const COLUMNS: readonly DataColumn<DerivedFontCheck>[] = [
  {
    cell: (check) => CHECK_NAMES[check.id],
    header: "Check",
    id: "check",
    kind: "label",
  },
  {
    cell: (check) => <OutcomeTag outcome={check.outcome} />,
    header: "Result",
    id: "result",
    kind: "text",
  },
  {
    cell: (check) => (
      <>
        <p>{check.message}</p>
        {check.details.length > 0 ? (
          <ul className="ty-export-details">
            {check.details.map((detail) => (
              <li key={detail}>{detail}</li>
            ))}
          </ul>
        ) : null}
      </>
    ),
    header: "What was found",
    id: "found",
    kind: "text",
  },
];

const checkKey = (check: DerivedFontCheck) => check.id;

const counted = (count: number, singular: string) =>
  `${count} ${singular}${count === 1 ? "" : "s"}`;

/** "6 of 6 checks passed", and never a pass for a check that did not run. */
export const summariseReport = ({ checks }: DerivedFontReport) => {
  const count = (outcome: DerivedFontCheck["outcome"]) =>
    checks.filter((check) => check.outcome === outcome).length;
  const failed = count("fail");
  const skipped = count("not-run");
  return [
    `${count("pass")} of ${counted(checks.length, "check")} passed`,
    failed > 0 ? `${failed} failed` : undefined,
    skipped > 0 ? `${skipped} did not run` : undefined,
  ]
    .filter((part) => part !== undefined)
    .join(", ");
};

/** The validation report of one derived font, check by check. */
export function CheckTable({
  fileName,
  report,
}: {
  readonly fileName: string;
  readonly report: DerivedFontReport;
}) {
  return (
    <DataTable
      caption={`Validation report for ${fileName}`}
      columns={COLUMNS}
      rowKey={checkKey}
      rows={report.checks}
    />
  );
}
