import { useMemo } from "react";
import type { ScriptExtension } from "~/generation/script-extension/extend";
import type { LetterIdentity } from "~/generation/script-extension/letter-identity";
import type { ShapingCheck } from "~/generation/script-extension/verify";
import { count } from "~/lib/count";
import { type DataColumn, DataTable } from "~/ui/content/data-table";
import {
  type CheckOutcome,
  type CheckRow,
  checkRows,
  failureLines,
} from "./check-rows";
import type { VerifiedExtension } from "./session";
import { WordFigure } from "./word-figure";

const OUTCOME_NAMES: Readonly<Record<CheckOutcome, string>> = {
  fail: "Failed",
  "not-run": "Did not run",
  pass: "Passed",
};

function OutcomeTag({ outcome }: { outcome: CheckOutcome }) {
  return (
    <span
      className="ty-label ty-extension-tag"
      data-on={outcome === "fail"}
      data-outcome={outcome}
      data-quiet={outcome === "not-run"}
    >
      {OUTCOME_NAMES[outcome]}
    </span>
  );
}

const CHECK_COLUMNS: readonly DataColumn<CheckRow>[] = [
  { cell: (row) => row.name, header: "Check", id: "name", kind: "text" },
  {
    cell: (row) => row.counted,
    header: "Passed",
    id: "counted",
    kind: "numeric",
  },
  {
    cell: (row) => <OutcomeTag outcome={row.outcome} />,
    header: "Result",
    id: "result",
    kind: "text",
  },
  { cell: (row) => row.note, header: "Note", id: "note", kind: "text" },
];

const checkKey = (row: CheckRow) => row.id;

const IDENTITY_COLUMNS: readonly DataColumn<LetterIdentity>[] = [
  {
    cell: (letter) => (
      <span className="ty-generate-literal">{letter.name}</span>
    ),
    header: "Letter",
    id: "name",
    kind: "label",
  },
  {
    cell: (letter) => letter.ownScore.toFixed(2),
    header: "With its own letter",
    id: "own",
    kind: "numeric",
  },
  {
    cell: (letter) => `${letter.closest}, ${letter.closestScore.toFixed(2)}`,
    header: "Closest letter",
    id: "closest",
    kind: "text",
  },
  {
    cell: (letter) => <OutcomeTag outcome={letter.pass ? "pass" : "fail"} />,
    header: "Result",
    id: "result",
    kind: "text",
  },
];

const identityKey = (letter: LetterIdentity) => letter.name;

/** The verdict in a sentence: what passed of what ran, and what did not run. */
const verdictOf = (rows: readonly CheckRow[], missing: number): string => {
  const ran = rows.filter((row) => row.outcome !== "not-run");
  const passed = ran.filter((row) => row.outcome === "pass").length;
  const notRun = rows.length - ran.length;
  const skipped =
    notRun > 0
      ? ` ${count(notRun, "check")} did not run and ${notRun === 1 ? "is" : "are"} not counted as passed.`
      : "";
  const unmade =
    missing > 0
      ? ` ${count(missing, "planned glyph")} ${missing === 1 ? "was" : "were"} not made, so the extension is not complete.`
      : "";
  return passed === ran.length
    ? `Every check that ran passed: ${passed} of ${ran.length}.${skipped}${unmade}`
    : `Not every check passed: ${passed} of ${ran.length} that ran.${skipped}${unmade}`;
};

interface WordProps {
  readonly check: ShapingCheck | undefined;
  readonly extension: ScriptExtension;
  readonly line: VerifiedExtension["words"][number];
  readonly number: number;
  readonly unitsPerEm: number;
}

function Word({ check, extension, line, number, unitsPerEm }: WordProps) {
  const pass = check?.pass ?? false;
  return (
    <li className="ty-extension-word" data-pass={pass} data-word={number}>
      <WordFigure
        extent={extension.style.extent}
        lines={[line]}
        name={`Test word ${number}, set in the built font's own outlines`}
        unitsPerEm={unitsPerEm}
      />
      <p className="ty-extension-word-line">
        <OutcomeTag outcome={pass ? "pass" : "fail"} />
        <span className="ty-code">{check?.got.join(" ") ?? ""}</span>
      </p>
      {pass ? null : <p>Planned: {check?.expected.join(" ") ?? "nothing"}.</p>}
    </li>
  );
}

interface VerificationReportViewProps {
  readonly extension: ScriptExtension;
  /** The face's units per em, which the built font keeps. */
  readonly unitsPerEm: number;
  readonly verified: VerifiedExtension;
}

/**
 * The verification report: the checks with their counts, each test word in
 * the built font's own outlines with the glyphs it shaped to, and the
 * report's list of what was not verified, in full.
 */
export function VerificationReportView({
  extension,
  unitsPerEm,
  verified,
}: VerificationReportViewProps) {
  const { familyName, latin, notVerified, report, withheldName, words } =
    verified;
  const rows = useMemo(() => checkRows(report), [report]);
  const failures = useMemo(() => failureLines(report), [report]);
  const passedWords = report.words.filter((word) => word.pass).length;
  const [firstWord] = words;
  const engineNotes = [
    ...report.validation.warnings.map((warning) => `Warning: ${warning}`),
    ...report.validation.notes,
  ];
  return (
    <div className="ty-generate-stack">
      <p
        data-extension-verification={report.pass ? "pass" : "fail"}
        data-words={report.words.length}
        data-words-passed={passedWords}
      >
        {verdictOf(rows, extension.missing.length)} Built as {familyName} for
        these checks.
        {withheldName
          ? ` The source font's licence reserves the name ${withheldName}, so the built font does not carry it.`
          : ""}{" "}
        The file is not kept: plan an export to get one.
      </p>
      <DataTable
        caption="Checks of the built font, with how many items of each passed"
        columns={CHECK_COLUMNS}
        rowKey={checkKey}
        rows={rows}
      />
      {failures.length > 0 ? (
        <>
          <h3 className="ty-label">What failed</h3>
          <ul className="ty-extension-list" data-extension-failures="">
            {failures.map((failure) => (
              <li key={failure}>{failure}</li>
            ))}
          </ul>
        </>
      ) : null}
      <h3 className="ty-label">
        Proof sheet. Test words: {passedWords} of {report.words.length} shape to
        the planned glyphs
      </h3>
      <ul
        aria-label="Test words in the built font's own outlines"
        className="ty-extension-words"
      >
        {words.map((line, index) => (
          <Word
            check={report.words[index]}
            extension={extension}
            key={line.text}
            line={line}
            number={index + 1}
            unitsPerEm={unitsPerEm}
          />
        ))}
      </ul>
      {firstWord ? (
        <figure className="ty-extension-beside">
          <WordFigure
            extent={extension.style.extent}
            lines={[latin, firstWord]}
            name="The face's own Latin beside the first test word, from the same built font"
            unitsPerEm={unitsPerEm}
          />
          <figcaption>
            The face's own Latin beside the first test word, from the same built
            font and on the same baseline. Ink is the source font. Carbon is the
            extension.
          </figcaption>
        </figure>
      ) : null}
      {report.identity ? (
        <>
          <h3 className="ty-label">
            Letter identity against {report.identity.reference}
          </h3>
          <p className="ty-extension-measure">
            Agreement is the overlap of the two shapes, from 0 to 1, with both
            letters on the same lines. It says which letter was drawn.{" "}
            {report.identity.reference} is another design, so these figures say
            nothing about style.
          </p>
          <DataTable
            caption={`Each generated letter against the letters of ${report.identity.reference}`}
            columns={IDENTITY_COLUMNS}
            rowKey={identityKey}
            rows={report.identity.letters}
          />
        </>
      ) : null}
      <h3 className="ty-label">Not verified</h3>
      <ul
        className="ty-extension-list"
        data-extension-not-verified={notVerified.length}
        lang={`und-${extension.plan.iso15924}`}
      >
        {notVerified.map((item) => (
          <li key={item}>{item}</li>
        ))}
      </ul>
      {engineNotes.length > 0 ? (
        <>
          <h3 className="ty-label">From the font engine</h3>
          <ul className="ty-extension-list">
            {engineNotes.map((note) => (
              <li key={note}>{note}</li>
            ))}
          </ul>
        </>
      ) : null}
    </div>
  );
}
