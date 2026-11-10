import "./variable.css";
import { useCallback } from "react";
import { type DataColumn, DataTable } from "~/ui/content/data-table";
import { TitleBlock, TitleBlockItem } from "~/ui/content/title-block";
import { Button } from "~/ui/controls/button";
import { saveBytes } from "~/workspace/files";
import { type Outcome, OutcomeTag } from "../outcome-tag";
import { formatSize, formatTime } from "../results-section";
import type { BuiltVariable, VariableCheckId } from "./variable-run";

interface CheckRow {
  readonly details: readonly string[];
  readonly id: string;
  readonly message: string;
  readonly name: string;
  readonly outcome: Outcome;
}

const CHECK_NAMES: Readonly<Record<VariableCheckId, string>> = {
  browser: "Browser sanitizer",
  engine: "Font engine",
};

/** The four checks of a static build's report that a rebuilt variable font does not get. */
const NOT_RUN: CheckRow = {
  details: [],
  id: "static-report",
  message:
    "A static build is also reopened and checked for the characters asked for, for shaping kept, and for ligatures and conjuncts. Those four checks are not made for a rebuilt variable font, so nothing here says it passed them.",
  name: "Reopening, characters, shaping, joining",
  outcome: "not-run",
};

const COLUMNS: readonly DataColumn<CheckRow>[] = [
  { cell: (row) => row.name, header: "Check", id: "check", kind: "label" },
  {
    cell: (row) => <OutcomeTag outcome={row.outcome} />,
    header: "Result",
    id: "result",
    kind: "text",
  },
  {
    cell: (row) => (
      <>
        <p>{row.message}</p>
        {row.details.length > 0 ? (
          <ul className="ty-export-details">
            {row.details.map((detail) => (
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

const rowKey = (row: CheckRow) => row.id;

const MILLISECONDS = 1000;

const seconds = (milliseconds: number) =>
  `${(milliseconds / MILLISECONDS).toFixed(1)} s`;

/** "2 of 2 checks that ran passed", and never a pass for a check that did not run. */
const summarise = ({ checks }: BuiltVariable): string => {
  const ran = checks.filter((check) => check.outcome !== "not-run");
  const passed = ran.filter((check) => check.outcome === "pass").length;
  const skipped = checks.length - ran.length;
  return [
    `${passed} of ${ran.length} ${ran.length === 1 ? "check" : "checks"} that ran passed`,
    skipped > 0 ? `${skipped} did not run` : undefined,
    "the four other checks of a static build were not made",
  ]
    .filter((part) => part !== undefined)
    .join(", ");
};

interface VariableResultProps {
  readonly familyName: string;
  readonly font: BuiltVariable;
}

/** One built variable font: its facts, exactly what was checked, the engine's notes, the download. */
export function VariableResult({ familyName, font }: VariableResultProps) {
  const download = useCallback(
    () => saveBytes(font.fileName, font.bytes),
    [font]
  );
  const { axis, timings } = font;
  const rows: CheckRow[] = [
    ...font.checks.map((check) => ({ ...check, name: CHECK_NAMES[check.id] })),
    NOT_RUN,
  ];
  return (
    <article
      className="ty-export-output ty-export-variable-result"
      data-testid="built-variable-font"
    >
      <h3 className="ty-heading">{font.fileName}</h3>
      <TitleBlock>
        <TitleBlockItem label="Built from" weight={2}>
          {font.masters.length} masters of {familyName}:{" "}
          {font.masters.join(", ")}
        </TitleBlockItem>
        <TitleBlockItem label="Axis">
          {axis.name}, {axis.min} to {axis.max}, default {axis.default}
        </TitleBlockItem>
        <TitleBlockItem label="Size">
          {formatSize(font.bytes.byteLength)}
        </TitleBlockItem>
        <TitleBlockItem label="Built at">
          {formatTime(font.builtAt)}
        </TitleBlockItem>
        <TitleBlockItem label="Checked" weight={2}>
          {summarise(font)}
        </TitleBlockItem>
      </TitleBlock>
      <DataTable
        caption={`What was checked in ${font.fileName}`}
        columns={COLUMNS}
        rowKey={rowKey}
        rows={rows}
      />
      <p data-testid="variable-timings">
        The engine took {seconds(timings.totalMs)}: {seconds(timings.mastersMs)}{" "}
        building the masters, {seconds(timings.checkMs)} comparing every glyph
        across them, {seconds(timings.mergeMs)} merging them and{" "}
        {seconds(timings.saveMs)} writing the file and reading it back. The font
        has {font.glyphCount} glyphs and {font.characterCount} characters.
      </p>
      {font.notes.length > 0 ? (
        <div>
          <h4 className="ty-label">Notes from the font engine</h4>
          <ul className="ty-export-details" data-testid="variable-notes">
            {font.notes.map((note) => (
              <li key={note}>{note}</li>
            ))}
          </ul>
        </div>
      ) : null}
      <div className="ty-export-actions">
        <Button onClick={download} symbol="download">
          Download {font.fileName}
        </Button>
      </div>
    </article>
  );
}
