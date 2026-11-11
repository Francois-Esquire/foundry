import { type CSSProperties, useMemo, useState } from "react";
import { outlineToPath } from "~/typeface/outline";
import { Slider } from "~/ui/controls/slider";
import { Mark } from "~/ui/symbols/mark";
import {
  outlineOnPhotograph,
  type RecoveredLetter,
  regionCorners,
} from "./core";
import { EvidencePicture } from "./evidence-picture";
import { type LetterReading, letterKey } from "./reading";
import { boxAround } from "./region-geometry";
import type { Photograph } from "./use-session";

const percent = (value: number) => `${value}%`;

const middleOf = (values: readonly number[]) => {
  const sorted = values.toSorted((a, b) => a - b);
  const half = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? (sorted[half] ?? 0)
    : ((sorted[half - 1] ?? 0) + (sorted[half] ?? 0)) / 2;
};

interface Laid {
  readonly letter: RecoveredLetter;
  /** The outline in evidence pixels, as path data. */
  readonly path: string;
}

interface FitCellProps {
  readonly laid: Laid;
  readonly photograph: Photograph;
}

/** One distinct letter: its outline over its own piece of the photograph, and its fit. */
function FitCell({ laid, photograph }: FitCellProps) {
  const { candidate, character, fit } = laid.letter;
  const letter = String.fromCodePoint(character);
  const region =
    candidate.provenance.origin === "reconstructed"
      ? candidate.provenance.region
      : undefined;
  const crop = region
    ? boxAround(
        [
          { x: region.x, y: region.y },
          { x: region.x + region.width, y: region.y + region.height },
        ],
        photograph.evidence,
        Math.max(region.width, region.height) * 0.12
      )
    : undefined;
  return (
    <li
      className="ty-reconstruct-fit"
      data-character={letter}
      data-fit={fit.toFixed(3)}
    >
      <EvidencePicture
        crop={crop}
        label={`The recovered outline of ${letter} over the photograph`}
        photograph={photograph}
      >
        <path className="ty-reconstruct-outline" d={laid.path} />
      </EvidencePicture>
      <span className="ty-label">
        {letter}, fit {fit.toFixed(2)}
      </span>
      <Mark kind="observed">Observed</Mark>
    </li>
  );
}

interface OutlinesSectionProps {
  readonly photograph: Photograph;
  readonly reading: LetterReading;
}

/** The recovered outlines laid over the photograph they were traced from. */
export function OutlinesSection({ photograph, reading }: OutlinesSectionProps) {
  const [opacity, setOpacity] = useState(50);
  const { recovery, sighting } = reading;
  const laid = useMemo(
    () =>
      recovery.recovered.map(
        (letter): Laid => ({
          letter,
          path: outlineToPath(outlineOnPhotograph(letter)),
        })
      ),
    [recovery.recovered]
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
  if (laid.length === 0) {
    return (
      <p>
        No outlines yet. A letter is traced once it has a label, so label the
        letters above.
      </p>
    );
  }
  const fits = laid.map(({ letter }) => letter.fit);
  const distinct = laid.filter(({ letter }) =>
    recovery.distinct.includes(letter)
  );
  return (
    <div
      className="ty-reconstruct-stack"
      style={{ "--ty-outline-opacity": opacity / 100 } as CSSProperties}
    >
      <div className="ty-reconstruct-controls">
        <Slider
          format={percent}
          label="Outline opacity"
          max={100}
          min={0}
          onChange={setOpacity}
          step={5}
          value={opacity}
        />
        <p data-distinct={distinct.length} data-traced={laid.length}>
          {laid.length} letters traced, {distinct.length} distinct characters.
          Lowest fit {Math.min(...fits).toFixed(2)}, middle fit{" "}
          {middleOf(fits).toFixed(2)}.
        </p>
      </div>
      <EvidencePicture
        className="ty-reconstruct-close"
        crop={crop}
        label={`The ${laid.length} recovered outlines laid over ${photograph.evidence.fileName}`}
        photograph={photograph}
      >
        {laid.map(({ letter, path }) => (
          <path
            className="ty-reconstruct-outline"
            d={path}
            key={letterKey(letter.reading)}
          />
        ))}
      </EvidencePicture>
      <p className="ty-lede">
        Fit is how much of the outline and of the isolated shape it was traced
        from overlap, from 0 to 1. Where a character was seen more than once,
        the one that agrees best with the others is kept. Every outline here was
        observed in the photograph.
      </p>
      <ul className="ty-reconstruct-fits">
        {distinct.map((entry) => (
          <FitCell
            key={letterKey(entry.letter.reading)}
            laid={entry}
            photograph={photograph}
          />
        ))}
      </ul>
    </div>
  );
}
