import { type ChangeEvent, type FocusEvent, useCallback, useMemo } from "react";
import { type DataColumn, DataTable } from "~/ui/content/data-table";
import { Button, ButtonLink } from "~/ui/controls/button";
import { Notice } from "~/ui/controls/notice";
import { Segmented } from "~/ui/controls/segmented";
import { TextField } from "~/ui/controls/text-field";
import {
  CONSIDERED_OPTIONS,
  type Considered,
  typedCharacter,
} from "./considered-characters";
import {
  type FaceMatch,
  letterOnPhotograph,
  type Reading,
  regionCorners,
} from "./core";
import { EvidencePicture, OverlayLine, polygonPath } from "./evidence-picture";
import { InkPicture } from "./pixel-picture";
import { NO_LETTERS_FOUND } from "./proposing";
import { type LetterReading, letterKey } from "./reading";
import { boxAround } from "./region-geometry";
import type { ReconstructSession, ReconstructState } from "./session";
import type { Photograph } from "./use-session";

/** A letter's tag on the photograph, as a share of the height shown. */
const TAG_SHARE = 0.055;

const letterOf = (character: number | undefined) =>
  character === undefined ? "" : String.fromCodePoint(character);

/** Who says what a letter is, in a sentence. */
const standingOf = (reading: Reading, labelled: boolean): string => {
  if (labelled) {
    return reading.character === undefined
      ? "Left out by you."
      : "Labelled by you.";
  }
  const [best] = reading.guesses;
  return best && reading.character !== undefined
    ? `Read by the recogniser, confidence ${best.confidence.toFixed(2)}.`
    : "Not read. Type its label.";
};

interface LetterCellProps {
  /** The character shown in the field: a person's label at once, else the reading. */
  readonly character: number | undefined;
  readonly disabled: boolean;
  /** True when a person's label stands over the recogniser's reading. */
  readonly labelled: boolean;
  readonly reading: Reading;
  readonly session: ReconstructSession;
}

function LetterCell({
  character,
  disabled,
  labelled,
  reading,
  session,
}: LetterCellProps) {
  const key = letterKey(reading);
  const place = `Line ${reading.line + 1}, letter ${reading.index + 1}`;
  const type = useCallback(
    (event: ChangeEvent<HTMLInputElement>) =>
      session.label(key, typedCharacter(event.currentTarget.value)),
    [key, session]
  );
  const selectAll = useCallback(
    (event: FocusEvent<HTMLInputElement>) => event.currentTarget.select(),
    []
  );
  const useReading = useCallback(() => session.clearLabel(key), [key, session]);
  return (
    <li
      className="ty-reconstruct-letter"
      data-labelled-by={labelled ? "person" : "recognizer"}
      data-letter={key}
    >
      <InkPicture ink={reading.letter.bitmap} label={`${place}, isolated`} />
      <TextField
        autoCapitalize="off"
        autoComplete="off"
        label={place}
        onChange={type}
        onFocus={selectAll}
        // Held still, a label can still be read and copied. A disabled field
        // is struck through, which would cross out the letter itself.
        readOnly={disabled}
        spellCheck={false}
        value={letterOf(character)}
      />
      <p className="ty-reconstruct-small">
        {standingOf(reading, labelled)}
        {reading.letter.runTogether
          ? " It is wide enough to be two letters run together."
          : ""}
      </p>
      {labelled ? (
        <Button disabled={disabled} onClick={useReading}>
          Use the reading
          <span className="ty-visually-hidden"> for {place}</span>
        </Button>
      ) : null}
    </li>
  );
}

const NEAREST_COLUMNS: readonly DataColumn<FaceMatch>[] = [
  { cell: (match) => match.name, header: "Face", id: "face", kind: "label" },
  {
    cell: (match) => match.agreement.toFixed(2),
    header: "Agreement, 0 to 1",
    id: "agreement",
    kind: "numeric",
  },
  {
    cell: (match) => match.letters,
    header: "Letters compared",
    id: "letters",
    kind: "numeric",
  },
  {
    cell: (match) => match.widthFactor.toFixed(2),
    header: "Width fitted, 1 is its own",
    id: "width",
    kind: "numeric",
  },
];

const matchKey = (match: FaceMatch) => match.reference;

/** The library's faces ranked by resemblance. Nearest is all that is claimed. */
function NearestFaces({ reading }: { readonly reading: LetterReading }) {
  const [nearest] = reading.nearest;
  return (
    <div className="ty-reconstruct-stack">
      <h3 className="ty-label">Nearest faces in the library</h3>
      {nearest ? (
        <>
          <p className="ty-lede">
            Of the faces in your library, {nearest.name} resembles this
            lettering most. This ranks resemblance among the faces you have
            imported. It does not identify the typeface.
          </p>
          <DataTable
            caption="Library faces ranked by resemblance to the lettering"
            columns={NEAREST_COLUMNS}
            rowKey={matchKey}
            rows={reading.nearest}
          />
        </>
      ) : (
        <p className="ty-lede">
          No face in the library could be compared with the labelled letters.
          Import fonts to see which of them the lettering resembles.
        </p>
      )}
    </div>
  );
}

interface LettersSectionProps {
  readonly photograph: Photograph;
  readonly reading: LetterReading;
  readonly session: ReconstructSession;
  readonly state: ReconstructState;
}

/** Every letter found, boxed on the photograph, with what it is taken for. */
export function LettersSection({
  photograph,
  reading,
  session,
  state,
}: LettersSectionProps) {
  const { readings, sighting } = reading;
  const locked = state.proposal !== undefined || state.proposing;
  const boxes = useMemo(
    () =>
      readings.map((found) => ({
        corners: letterOnPhotograph(sighting, found),
        found,
      })),
    [readings, sighting]
  );
  const crop = useMemo(
    () =>
      boxAround(
        regionCorners(sighting.view.region),
        photograph.evidence,
        photograph.evidence.width / 100
      ),
    [photograph.evidence, sighting.view.region]
  );
  // Tags are set in pixels of the photograph, so they keep their size beside the letters.
  const tagSize = crop.height * TAG_SHARE;
  const setConsidered = useCallback(
    (considered: Considered) => session.setOptions({ considered }),
    [session]
  );
  const lines = sighting.isolation.lines.map((_, line) =>
    readings.filter((found) => found.line === line)
  );
  const labelled = readings.filter(
    (found) => found.character !== undefined
  ).length;

  return (
    <div className="ty-reconstruct-stack">
      <div className="ty-reconstruct-actions">
        <Segmented
          disabled={locked}
          label="Read letters as"
          onChange={setConsidered}
          options={CONSIDERED_OPTIONS}
          value={state.options.considered}
        />
        <p data-found={readings.length} data-labelled={labelled}>
          {readings.length} letters found in {lines.length}{" "}
          {lines.length === 1 ? "line" : "lines"}, {labelled} labelled.
        </p>
      </div>
      {reading.references === 0 ? (
        <Notice action={<ButtonLink href="#/import">Open Import</ButtonLink>}>
          No face in the library draws these characters, so the letters could
          not be read. Type each label below, or import fonts and come back.
        </Notice>
      ) : null}
      <EvidencePicture
        className="ty-reconstruct-close"
        crop={crop}
        label={`The lettering on ${photograph.evidence.fileName}, with a box around each of the ${readings.length} letters found`}
        photograph={photograph}
      >
        {boxes.map(({ corners, found }) => (
          <g key={letterKey(found)}>
            <OverlayLine d={polygonPath(corners)} />
            <text
              className="ty-reconstruct-tag"
              fontSize={tagSize}
              x={corners[0]?.x}
              y={(corners[0]?.y ?? 0) - tagSize / 3}
            >
              {letterOf(found.character)}
            </text>
          </g>
        ))}
      </EvidencePicture>
      {readings.length === 0 ? (
        <p>{NO_LETTERS_FOUND}</p>
      ) : (
        <>
          <p className="ty-lede">
            Type over a label to correct it. Clear a label to leave the shape
            out. Confidence ranks the recogniser's guesses and is not a
            probability.
          </p>
          {lines.map((line, index) => (
            <ol
              aria-label={`Line ${index + 1}`}
              className="ty-reconstruct-letters"
              // Lines keep their order for as long as the region is read the same way.
              key={line[0] ? letterKey(line[0]) : index}
            >
              {line.map((found) => {
                const key = letterKey(found);
                const byPerson = state.labels.has(key);
                return (
                  <LetterCell
                    character={
                      byPerson ? state.labels.get(key) : found.character
                    }
                    disabled={locked}
                    key={key}
                    labelled={byPerson}
                    reading={found}
                    session={session}
                  />
                );
              })}
            </ol>
          ))}
        </>
      )}
      <NearestFaces reading={reading} />
    </div>
  );
}
