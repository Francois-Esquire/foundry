import "./variable.css";
import { useCallback } from "react";
import { count } from "~/lib/count";
import type { Check } from "~/packaging/validation";
import { formatSize, formatTime } from "~/ui/content/output-format";
import { TitleBlock, TitleBlockItem } from "~/ui/content/title-block";
import { Button } from "~/ui/controls/button";
import { saveBytes } from "~/workspace/files";
import { CHECK_NAMES } from "../check-names";
import { CheckTable } from "../check-table";
import type { BuiltVariable } from "./variable-run";

/** The four checks of a static build's report that a rebuilt variable font does not get. */
const NOT_RUN: Check<"static-report"> = {
  details: [],
  id: "static-report",
  message:
    "A static build is also reopened and checked for the characters asked for, for shaping kept, and for ligatures and conjuncts. Those four checks are not made for a rebuilt variable font, so nothing here says it passed them.",
  outcome: "not-run",
};

const MILLISECONDS = 1000;

const seconds = (milliseconds: number) =>
  `${(milliseconds / MILLISECONDS).toFixed(1)} s`;

/** "2 of 2 checks that ran passed", and never a pass for a check that did not run. */
const summarise = ({ checks }: BuiltVariable): string => {
  const ran = checks.filter((check) => check.outcome !== "not-run");
  const passed = ran.filter((check) => check.outcome === "pass").length;
  const skipped = checks.length - ran.length;
  return [
    `${passed} of ${count(ran.length, "check")} that ran passed`,
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
  const rows = [...font.checks, NOT_RUN];
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
      <CheckTable
        caption={`What was checked in ${font.fileName}`}
        checks={rows}
        names={CHECK_NAMES}
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
