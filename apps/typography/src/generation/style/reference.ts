/**
 * Analyse: what a source face looks like in numbers, so later stages can fit
 * new glyphs to it and judge whether they belong.
 */
import type { AxisLocation } from "~/typeface/face";
import type { Outline } from "~/typeface/outline";
import type { GlyphShape, OpenFace } from "~/typeface/reading";
import {
  dominantLength,
  type EdgeShape,
  edgeShapes,
  type InkMeasure,
  measureInk,
  measureResolution,
  median,
  quantile,
  slantOf,
} from "./measure";

/** Where a vertical metric came from. */
type MetricSource = "assumed" | "declared" | "measured";

type VerticalLine = "ascender" | "capHeight" | "descender" | "xHeight";

/** Heights above the baseline, which is always 0. The descender is negative. */
interface VerticalMetrics {
  readonly ascender: number;
  readonly capHeight: number;
  readonly descender: number;
  /** Measured from glyphs where the face has them, else the font's own field, else assumed. */
  readonly sources: Readonly<Record<VerticalLine, MetricSource>>;
  readonly xHeight: number;
}

export interface StyleReference {
  /** The mean advance of the measured glyphs. */
  readonly averageAdvance: number;
  /** The characters the measurements were taken from. */
  readonly characters: readonly number[];
  /** Upright stroke thickness over level stroke thickness. 1 is monoline. */
  readonly contrast: number;
  /**
   * The highest and lowest a glyph may reach: the face's declared ascender
   * and descender, widened to the measured ones where those reach further.
   */
  readonly extent: { readonly bottom: number; readonly top: number };
  /**
   * Ink area over the box of advance by ink height, per glyph: the middle
   * value and the range most glyphs fall in.
   */
  readonly inkDensity: {
    readonly high: number;
    readonly low: number;
    readonly median: number;
  };
  readonly location?: AxisLocation;
  readonly metrics: VerticalMetrics;
  /** How far round shapes reach past the lines flat shapes stop at. */
  readonly overshoot: number;
  /** The space beside a glyph, by the shape of the edge that faces it. */
  readonly sidebearings: Readonly<Record<EdgeShape, number>>;
  /** Degrees clockwise from upright. */
  readonly slant: number;
  readonly stems: {
    /** Thickness of level strokes, measured vertically. */
    readonly horizontal: number;
    /** Thickness of upright strokes, measured horizontally. */
    readonly vertical: number;
  };
  readonly unitsPerEm: number;
}

export interface AnalyseOptions {
  /** The characters to measure. Chosen from the face when absent. */
  readonly characters?: readonly number[];
  readonly location?: AxisLocation;
}

const SAMPLE_LIMIT = 48;
const LATIN_SAMPLE = "HOEIATVXZnoeilvxzpdbqgahkuy";
const LETTER = /\p{L}/u;

/** Latin letters whose tops or bottoms mark each line, flattest first. */
const LINE_LETTERS: Readonly<
  Record<
    VerticalLine,
    { readonly letters: string; readonly edge: "top" | "bottom" }
  >
> = {
  ascender: { edge: "top", letters: "ldbhk" },
  capHeight: { edge: "top", letters: "HIETZ" },
  descender: { edge: "bottom", letters: "pqgy" },
  xHeight: { edge: "top", letters: "xvwz" },
};
const ROUND_LETTERS = "oO";

const codePoints = (text: string) =>
  [...text].map((character) => character.codePointAt(0) ?? 0);

/**
 * The characters to measure: the Latin sample when the face has it, else an
 * even spread of the face's own letters, so no script is measured by another's.
 */
export const chooseSample = (face: OpenFace): number[] => {
  const latin = codePoints(LATIN_SAMPLE).filter(
    (character) => face.glyphForCharacter(character) !== undefined
  );
  if (latin.length >= LATIN_SAMPLE.length / 2) {
    return latin;
  }
  const letters = [...face.characters()].filter((character) =>
    LETTER.test(String.fromCodePoint(character))
  );
  const step = Math.max(1, Math.ceil(letters.length / SAMPLE_LIMIT));
  return letters.filter((_, index) => index % step === 0);
};

interface Measured {
  readonly character: number;
  readonly ink: InkMeasure;
  readonly shape: GlyphShape;
}

const shapeFor = (
  face: OpenFace,
  character: number,
  location: AxisLocation | undefined
): GlyphShape | undefined => {
  const glyphId = face.glyphForCharacter(character);
  return glyphId === undefined ? undefined : face.glyph(glyphId, location);
};

const measureCharacters = (
  face: OpenFace,
  characters: readonly number[],
  location: AxisLocation | undefined
): Measured[] => {
  const measured: Measured[] = [];
  for (const character of characters) {
    const shape = shapeFor(face, character, location);
    const ink =
      shape && measureInk(shape.outline, face.description.metrics.unitsPerEm);
    if (shape && ink) {
      measured.push({ character, ink, shape });
    }
  }
  return measured;
};

const measuredLine = (
  face: OpenFace,
  line: VerticalLine,
  location: AxisLocation | undefined
): number | undefined => {
  const { edge, letters } = LINE_LETTERS[line];
  const values = measureCharacters(face, codePoints(letters), location).map(
    ({ ink }) => (edge === "top" ? ink.bounds.yMax : ink.bounds.yMin)
  );
  return median(values);
};

const verticalMetrics = (
  face: OpenFace,
  location: AxisLocation | undefined
): VerticalMetrics => {
  const declared = face.description.metrics;
  const assumed: Readonly<Record<VerticalLine, number>> = {
    ascender: declared.ascender,
    capHeight: declared.unitsPerEm * 0.7,
    descender: declared.descender,
    xHeight: declared.unitsPerEm * 0.5,
  };
  const fields: Readonly<Record<VerticalLine, number | undefined>> = {
    ascender: declared.ascender,
    capHeight: declared.capHeight,
    descender: declared.descender,
    xHeight: declared.xHeight,
  };
  const resolve = (line: VerticalLine): [number, MetricSource] => {
    const measured = measuredLine(face, line, location);
    if (measured !== undefined) {
      return [measured, "measured"];
    }
    const field = fields[line];
    return field ? [field, "declared"] : [assumed[line], "assumed"];
  };
  const [ascender, ascenderSource] = resolve("ascender");
  const [capHeight, capHeightSource] = resolve("capHeight");
  const [descender, descenderSource] = resolve("descender");
  const [xHeight, xHeightSource] = resolve("xHeight");
  return {
    ascender,
    capHeight,
    descender,
    sources: {
      ascender: ascenderSource,
      capHeight: capHeightSource,
      descender: descenderSource,
      xHeight: xHeightSource,
    },
    xHeight,
  };
};

/** How far the round letters reach below the baseline, the one line every face shares. */
const overshootOf = (
  face: OpenFace,
  location: AxisLocation | undefined
): number => {
  const reaches = measureCharacters(face, codePoints(ROUND_LETTERS), location)
    .map(({ ink }) => -ink.bounds.yMin)
    .filter((reach) => reach >= 0);
  return median(reaches) ?? 0;
};

const sidebearingsOf = (
  measured: readonly Measured[],
  slant: number
): Readonly<Record<EdgeShape, number>> => {
  const bearings: Record<EdgeShape, number[]> = {
    diagonal: [],
    round: [],
    straight: [],
  };
  for (const { ink, shape } of measured) {
    const edges = edgeShapes(shape.outline, slant);
    if (edges) {
      bearings[edges.left].push(ink.bounds.xMin);
      bearings[edges.right].push(shape.advance - ink.bounds.xMax);
    }
  }
  const all = Object.values(bearings).flat();
  const typical = (shape: EdgeShape) =>
    median(bearings[shape]) ?? median(all) ?? 0;
  return {
    diagonal: typical("diagonal"),
    round: typical("round"),
    straight: typical("straight"),
  };
};

/** Ink area over the box of advance by ink height. */
export const inkDensityOf = (ink: InkMeasure, advance: number): number => {
  const box = advance * (ink.bounds.yMax - ink.bounds.yMin);
  return box > 0 ? ink.area / box : 0;
};

/** Measures a face at one axis location. */
export const analyseStyle = (
  face: OpenFace,
  options: AnalyseOptions = {}
): StyleReference => {
  const { unitsPerEm } = face.description.metrics;
  const characters = options.characters ?? chooseSample(face);
  const measured = measureCharacters(face, characters, options.location);
  const outlines: Outline[] = measured.map(({ shape }) => shape.outline);
  const resolution = measureResolution(unitsPerEm);
  const vertical =
    dominantLength(
      measured.flatMap(({ ink }) => ink.horizontalRuns),
      resolution
    ) ?? 0;
  const horizontal =
    dominantLength(
      measured.flatMap(({ ink }) => ink.verticalRuns),
      resolution
    ) ?? 0;
  const slant = slantOf(outlines);
  const densities = measured
    .filter(({ shape }) => shape.advance > 0)
    .map(({ ink, shape }) => inkDensityOf(ink, shape.advance));
  const advances = measured.map(({ shape }) => shape.advance);
  const metrics = verticalMetrics(face, options.location);
  const declared = face.description.metrics;
  return {
    averageAdvance:
      advances.reduce((sum, advance) => sum + advance, 0) /
      Math.max(1, advances.length),
    characters: measured.map(({ character }) => character),
    contrast: horizontal > 0 ? vertical / horizontal : 1,
    extent: {
      bottom: Math.min(declared.descender, metrics.descender),
      top: Math.max(declared.ascender, metrics.ascender, metrics.capHeight),
    },
    inkDensity: {
      high: quantile(densities, 0.9),
      low: quantile(densities, 0.1),
      median: median(densities) ?? 0,
    },
    location: options.location,
    metrics,
    overshoot: overshootOf(face, options.location),
    sidebearings: sidebearingsOf(measured, slant),
    slant,
    stems: { horizontal, vertical },
    unitsPerEm,
  };
};
