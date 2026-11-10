/**
 * Vector recovery: each labelled letter is traced and brought into font
 * units. A line has one scale, taken from its body height, so its letters
 * keep their relative size. Sidebearings come from the measured gaps between
 * neighbouring letters. Every result is a candidate with reconstructed,
 * observed provenance.
 */
import { cleanOutline, debrisArea } from "~/generation/normalise/clean";
import type { NewCandidate } from "~/generation/pipeline/stages";
import { targetKeyFor } from "~/generation/plan/target";
import {
  type RasterFrame,
  tracedToOutline,
} from "~/generation/raster/rasterize";
import { median } from "~/generation/style/measure";
import { contourTracer } from "~/generation/vector/trace";
import type { TraceOptions, Vectorizer } from "~/generation/vector/vectorizer";
import { outlineBounds, transformOutline } from "~/typeface/outline";
import type { RegionView } from "../evidence/rectify";
import { boxAround } from "../evidence/region";
import {
  baselineAt,
  type LetteringLine,
  type LetterShape,
} from "../isolation/letters";
import { CUT_MARGIN } from "../isolation/pieces";
import { agreement, normaliseLetter } from "../recognition/normal-form";
import type { Reading } from "../recognition/recognizer";
import {
  type Correspondence,
  correspondenceOf,
  fitScore,
} from "./correspondence";
import { namingFor, type TargetFace } from "./naming";

/** The font units a line's measured heights are mapped to. */
export interface RecoveryMetrics {
  readonly ascender: number;
  readonly capHeight: number;
  readonly descender: number;
  readonly unitsPerEm: number;
  readonly xHeight: number;
}

export const DEFAULT_METRICS: RecoveryMetrics = {
  ascender: 800,
  capHeight: 700,
  descender: -200,
  unitsPerEm: 1000,
  xHeight: 500,
};

export interface RecoveryRequest {
  readonly evidenceId: string;
  readonly lines: readonly LetteringLine[];
  readonly metrics?: RecoveryMetrics;
  /** Only readings with a character are recovered: an outline needs to know what it is. */
  readonly readings: readonly Reading[];
  readonly target: TargetFace;
  readonly trace?: TraceOptions;
  /** The tracer to use. Generation's contour tracer when absent. */
  readonly vectorizer?: Vectorizer;
  readonly view: RegionView;
}

interface Sidebearing {
  /**
   * `neighbour`: half the measured gap to the letter beside it. `line`: the
   * letter has a word space or the end of the line on that side, so the
   * line's usual half gap stands in.
   */
  readonly from: "line" | "neighbour";
  /** In font units. */
  readonly value: number;
}

export interface RecoveredLetter {
  readonly candidate: NewCandidate;
  readonly character: number;
  readonly correspondence: Correspondence;
  /** Intersection over union of the outline, drawn back, with the isolated shape. 0 to 1. */
  readonly fit: number;
  readonly reading: Reading;
  readonly sidebearings: {
    readonly left: Sidebearing;
    readonly right: Sidebearing;
  };
  /** The one scale of the letter's line. */
  readonly unitsPerPixel: number;
}

/** With no neighbour anywhere on the line, a tenth of the body height is left on each side. */
const LONE_BEARING = 0.1;

interface LineSpacing {
  /** Half gaps in pixels, by the letter's left edge. */
  readonly left: ReadonlyMap<LetterShape, number>;
  readonly right: ReadonlyMap<LetterShape, number>;
  /** The usual half gap of the line, in pixels. */
  readonly usual: number;
}

const spacingOf = (line: LetteringLine): LineSpacing => {
  const across = line.letters.toSorted((a, b) => a.box.left - b.box.left);
  const left = new Map<LetterShape, number>();
  const right = new Map<LetterShape, number>();
  for (const [index, letter] of across.entries()) {
    const before = across[index - 1];
    if (before && !letter.spaceLeft && letter.gapLeft !== undefined) {
      left.set(letter, letter.gapLeft / 2);
      right.set(before, letter.gapLeft / 2);
    }
  }
  return {
    left,
    right,
    usual: median([...left.values()]) ?? LONE_BEARING * line.bodyHeight,
  };
};

const bearing = (
  measured: number | undefined,
  usual: number,
  unitsPerPixel: number
): Sidebearing => ({
  from: measured === undefined ? "line" : "neighbour",
  // Letters whose boxes overlap, as a kerned pair's do, have a negative gap.
  value: Math.round((measured ?? usual) * unitsPerPixel),
});

const evidenceRegion = (letter: LetterShape, view: RegionView) => {
  const { bottom, left, right, top } = letter.box;
  return boxAround(
    [
      { x: left, y: top },
      { x: right, y: top },
      { x: right, y: bottom },
      { x: left, y: bottom },
    ].map(view.toEvidence)
  );
};

/** Traces every labelled letter into font units and makes a candidate of each. */
export const recoverLetters = (request: RecoveryRequest): RecoveredLetter[] => {
  const metrics = request.metrics ?? DEFAULT_METRICS;
  const vectorizer = request.vectorizer ?? contourTracer;
  const naming = namingFor(request.target);
  const spacings = request.lines.map(spacingOf);
  const recovered: RecoveredLetter[] = [];
  for (const reading of request.readings) {
    const line = request.lines[reading.line];
    const spacing = spacings[reading.line];
    const { character, letter } = reading;
    if (!(line && spacing) || character === undefined) {
      continue;
    }
    const traced = vectorizer.trace(letter.bitmap, request.trace);
    const tracedBounds = outlineBounds(traced);
    if (!tracedBounds) {
      continue;
    }
    const bodyUnits =
      line.body === "cap-height" ? metrics.capHeight : metrics.xHeight;
    const unitsPerPixel = bodyUnits / line.bodyHeight;
    const left = bearing(
      spacing.left.get(letter),
      spacing.usual,
      unitsPerPixel
    );
    const right = bearing(
      spacing.right.get(letter),
      spacing.usual,
      unitsPerPixel
    );
    const centre = (letter.box.left + letter.box.right) / 2;
    const cutTop = letter.box.top - CUT_MARGIN;
    const frame: RasterFrame = {
      height: letter.bitmap.height,
      left: left.value - tracedBounds.xMin * unitsPerPixel,
      scale: 1 / unitsPerPixel,
      top: (baselineAt(line, centre) - cutTop) * unitsPerPixel,
      width: letter.bitmap.width,
    };
    const { outline } = cleanOutline(
      transformOutline(traced, tracedToOutline(frame)),
      { minimumArea: debrisArea(0, metrics.unitsPerEm) }
    );
    const bounds = outlineBounds(outline);
    if (!bounds) {
      continue;
    }
    const { name, replaces } = naming(character);
    const region = evidenceRegion(letter, request.view);
    // The place on the evidence is part of the id, so letters from two
    // regions of one photograph never share one.
    const place = [region.x, region.y, region.width, region.height]
      .map((value) => Math.round(value))
      .join(",");
    recovered.push({
      candidate: {
        advance: Math.max(0, Math.round(bounds.xMax + right.value)),
        characters: [character],
        faceId: request.target.faceId,
        id: `reconstructed:${request.evidenceId.slice(0, 12)}:${place}:${targetKeyFor(character)}`,
        name,
        outline,
        provenance: {
          basis: "observed",
          confidence:
            reading.labelledBy === "person"
              ? 1
              : (reading.guesses[0]?.confidence ?? 0),
          evidenceId: request.evidenceId,
          origin: "reconstructed",
          region,
        },
        replaces,
      },
      character,
      correspondence: correspondenceOf(
        frame,
        { x: letter.box.left - CUT_MARGIN, y: cutTop },
        request.view
      ),
      fit: fitScore(outline, frame, letter.bitmap),
      reading,
      sidebearings: { left, right },
      unitsPerPixel,
    });
  }
  return recovered;
};

/**
 * One recovered letter for each distinct character: where a character was
 * seen several times, the one that agrees best with the others, since that
 * is the least likely to carry a flaw of its own.
 */
export const distinctLetters = (
  recovered: readonly RecoveredLetter[],
  lines: readonly LetteringLine[]
): RecoveredLetter[] => {
  const byCharacter = new Map<number, RecoveredLetter[]>();
  for (const letter of recovered) {
    byCharacter.set(letter.character, [
      ...(byCharacter.get(letter.character) ?? []),
      letter,
    ]);
  }
  return [...byCharacter.values()].flatMap((instances) => {
    const forms = instances.flatMap(({ reading }) => {
      const line = lines[reading.line];
      return line ? [normaliseLetter(reading.letter, line)] : [];
    });
    let [best] = instances;
    let bestScore = -1;
    for (const [index, instance] of instances.entries()) {
      const mine = forms[index];
      const score = mine
        ? forms.reduce(
            (sum, other, at) =>
              at === index ? sum : sum + agreement(mine, other),
            0
          )
        : 0;
      if (score > bestScore) {
        best = instance;
        bestScore = score;
      }
    }
    return best ? [best] : [];
  });
};
