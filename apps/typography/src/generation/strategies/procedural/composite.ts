/**
 * Builds an accented letter from a base and its marks. Each mark is placed
 * from measured geometry: the bounds of the base, the lines of the face, and
 * where the face's own accented letters carry the same mark.
 */
import type { AxisLocation } from "~/typeface/face";
import {
  type Bounds,
  type Outline,
  outlineBounds,
  translateOutline,
} from "~/typeface/outline";
import type { GlyphShape, OpenFace } from "~/typeface/reading";
import {
  decompose,
  dotlessForm,
  type MarkAttachment,
  markAttachment,
  markForms,
} from "../../plan/marks";
import { characterLabel } from "../../plan/target";
import { median } from "../../style/measure";
import type { StyleReference } from "../../style/reference";

export interface Part {
  /**
   * The x the part is centred on. For a base it is the middle of its bounds.
   * A mark such as an acute leans, so its bounds are not centred on the
   * letter beneath it: its axis is read from the face's spacing form of the
   * mark, which the designer centred in its own advance.
   */
  readonly axis: number;
  readonly bounds: Bounds;
  readonly character: number;
  readonly shape: GlyphShape;
}

/** Where a mark ended up, and what the position was taken from. */
interface MarkPlacement {
  readonly basis: string;
  readonly dx: number;
  readonly dy: number;
}

export interface Composite {
  readonly advance: number;
  readonly outline: Outline;
  readonly rule: string;
  readonly weaknesses: readonly string[];
}

export interface PartSource {
  /** Characters whose glyphs must not be read, so a holdout stays honest. */
  readonly exclude: ReadonlySet<number>;
  readonly face: OpenFace;
  /** Use the face's own accented letters as a guide for placing marks. */
  readonly learnFromComposites: boolean;
  readonly location?: AxisLocation;
  readonly style: StyleReference;
}

const centreX = (bounds: Bounds) => (bounds.xMin + bounds.xMax) / 2;

const SAMPLE_LIMIT = 12;
const MATCH_SLACK = 2;

export const partFor = (
  source: PartSource,
  character: number
): Part | undefined => {
  const glyphId = source.exclude.has(character)
    ? undefined
    : source.face.glyphForCharacter(character);
  if (glyphId === undefined) {
    return;
  }
  const shape = source.face.glyph(glyphId, source.location);
  const bounds = outlineBounds(shape.outline);
  return bounds && { axis: centreX(bounds), bounds, character, shape };
};

const width = (bounds: Bounds) => bounds.xMax - bounds.xMin;

/** The glyph that draws a mark: the combining mark itself, or its spacing form. */
const markPartFor = (source: PartSource, mark: number): Part | undefined => {
  const [combining, spacing] = markForms(mark).map((form) =>
    partFor(source, form)
  );
  const centred =
    spacing && spacing.shape.advance > 0
      ? { ...spacing, axis: spacing.shape.advance / 2 }
      : spacing;
  if (!combining) {
    return centred;
  }
  const sameDrawing =
    centred && Math.abs(width(centred.bounds) - width(combining.bounds)) <= 2;
  return sameDrawing
    ? {
        ...combining,
        axis: combining.bounds.xMin + (centred.axis - centred.bounds.xMin),
      }
    : combining;
};

const lineTolerance = (style: StyleReference) =>
  Math.max(2 * style.overshoot, 0.02 * style.unitsPerEm);

/** The line the top of a glyph belongs to, or its own top when it follows none. */
const topLineOf = (bounds: Bounds, style: StyleReference): number => {
  const { ascender, capHeight, xHeight } = style.metrics;
  const tolerance = lineTolerance(style);
  return (
    [xHeight, capHeight, ascender].find(
      (line) => Math.abs(bounds.yMax - line) <= tolerance
    ) ?? bounds.yMax
  );
};

/** How far the base stands above the x-height, which marks above are drawn for. */
const liftOf = (base: Bounds, style: StyleReference): number => {
  const lift = topLineOf(base, style) - style.metrics.xHeight;
  return lift > lineTolerance(style) ? lift : 0;
};

const sameSize = (a: Bounds, b: Bounds) =>
  Math.abs(a.xMax - a.xMin - (b.xMax - b.xMin)) <= MATCH_SLACK &&
  Math.abs(a.yMax - a.yMin - (b.yMax - b.yMin)) <= MATCH_SLACK;

/**
 * How far a mark was moved inside an existing accented letter, found by
 * looking for contours of the mark's size among the letter's contours.
 */
const markOffsetIn = (
  composite: Outline,
  mark: Outline
): { readonly dx: number; readonly dy: number } | undefined => {
  const boundsOf = (outline: Outline) =>
    outline.contours
      .map((contour) => outlineBounds({ contours: [contour] }))
      .filter((bounds) => bounds !== undefined);
  const markBounds = boundsOf(mark);
  const compositeBounds = boundsOf(composite);
  const [first] = markBounds;
  if (!first) {
    return;
  }
  for (const candidate of compositeBounds) {
    if (!sameSize(candidate, first)) {
      continue;
    }
    const dx = candidate.xMin - first.xMin;
    const dy = candidate.yMin - first.yMin;
    const allFound = markBounds.every((piece) =>
      compositeBounds.some(
        (other) =>
          sameSize(other, piece) &&
          Math.abs(other.xMin - piece.xMin - dx) <= MATCH_SLACK &&
          Math.abs(other.yMin - piece.yMin - dy) <= MATCH_SLACK
      )
    );
    if (allFound) {
      return { dx, dy };
    }
  }
};

interface Sample {
  /** The mark's centre relative to the base's centre. */
  readonly aside: number;
  readonly character: number;
  /** How far the mark was raised beyond the lift of its base. */
  readonly raise: number;
  readonly tall: boolean;
}

const sampleFrom = (
  source: PartSource,
  character: number,
  mark: number
): Sample | undefined => {
  const parts = decompose(character);
  if (parts?.marks.length !== 1 || parts.marks[0] !== mark) {
    return;
  }
  const composite = partFor(source, character);
  const base =
    partFor(source, dotlessForm(parts.base) ?? parts.base) ??
    partFor(source, parts.base);
  const markPart = markPartFor(source, mark);
  if (!(composite && base && markPart)) {
    return;
  }
  const offset = markOffsetIn(composite.shape.outline, markPart.shape.outline);
  if (!offset) {
    return;
  }
  const lift = liftOf(base.bounds, source.style);
  return {
    aside: centreX(markPart.bounds) + offset.dx - centreX(base.bounds),
    character,
    raise: offset.dy - lift,
    tall: lift > 0,
  };
};

/** Accented letters in the face that carry the mark, as examples of where it goes. */
const samplesFor = (source: PartSource, mark: number): Sample[] => {
  const samples: Sample[] = [];
  for (const character of source.face.characters()) {
    if (samples.length >= SAMPLE_LIMIT) {
      break;
    }
    const sample = source.exclude.has(character)
      ? undefined
      : sampleFrom(source, character, mark);
    if (sample) {
      samples.push(sample);
    }
  }
  return samples;
};

const named = (characters: readonly number[]) =>
  characters.map((character) => String.fromCodePoint(character)).join(" ");

const learnedPlacement = (
  source: PartSource,
  base: Part,
  mark: Part,
  markCharacter: number
): MarkPlacement | undefined => {
  const tall = liftOf(base.bounds, source.style) > 0;
  const samples = samplesFor(source, markCharacter).filter(
    (sample) => sample.tall === tall
  );
  const aside = median(samples.map((sample) => sample.aside));
  const raise = median(samples.map((sample) => sample.raise));
  if (aside === undefined || raise === undefined) {
    return;
  }
  return {
    basis: `placed as the face places it in ${named(samples.map((sample) => sample.character))}`,
    dx: centreX(base.bounds) + aside - centreX(mark.bounds),
    dy: raise + liftOf(base.bounds, source.style),
  };
};

const slantShift = (style: StyleReference, height: number) =>
  Math.tan((style.slant * Math.PI) / 180) * height;

const geometricPlacement = (
  style: StyleReference,
  base: Bounds,
  { axis, bounds: mark }: Part,
  attachment: MarkAttachment
): MarkPlacement => {
  const centred = centreX(base) - axis;
  if (attachment === "ogonek") {
    return {
      basis:
        "set against the right foot of the base, where a drawn ogonek would grow out of the stroke",
      dx: base.xMax - mark.xMax,
      dy: 0,
    };
  }
  if (attachment === "cedilla" || attachment === "overlay") {
    return { basis: "centred on the base", dx: centred, dy: 0 };
  }
  if (attachment === "below") {
    return {
      basis: "centred under the base",
      dx: centred,
      dy: Math.min(0, base.yMin + lineTolerance(style)),
    };
  }
  const clearance = 0.4 * style.stems.horizontal;
  const lift = liftOf(base, style);
  const dy = lift + Math.max(0, base.yMax + clearance - (mark.yMin + lift));
  return {
    basis:
      "centred over the base on the mark's own axis, at the height the face draws it over the x-height, raised with the base",
    dx: centred + slantShift(style, mark.yMin + dy - style.metrics.xHeight),
    dy,
  };
};

const placeMark = (
  source: PartSource,
  base: Part,
  mark: Part,
  markCharacter: number
): MarkPlacement =>
  (source.learnFromComposites
    ? learnedPlacement(source, base, mark, markCharacter)
    : undefined) ??
  geometricPlacement(
    source.style,
    base.bounds,
    mark,
    markAttachment(markCharacter)
  );

const withTop = (bounds: Bounds, top: number): Bounds => ({
  ...bounds,
  yMax: Math.max(bounds.yMax, top),
});

/** Builds the composite, or says which part is missing. */
export const composeComposite = (
  source: PartSource,
  baseCharacter: number,
  marks: readonly number[]
): Composite | { readonly missing: string } => {
  const base = partFor(source, baseCharacter);
  if (!base) {
    return { missing: `the base ${characterLabel(baseCharacter)}` };
  }
  let stack = base;
  const contours = [...base.shape.outline.contours];
  const placed: string[] = [];
  const weaknesses: string[] = [];
  for (const [index, markCharacter] of marks.entries()) {
    const mark = markPartFor(source, markCharacter);
    if (!mark) {
      return { missing: `the mark ${characterLabel(markCharacter)}` };
    }
    const placement = placeMark(source, stack, mark, markCharacter);
    contours.push(
      ...translateOutline(mark.shape.outline, placement.dx, placement.dy)
        .contours
    );
    placed.push(
      `${characterLabel(markCharacter)} from the glyph of ${characterLabel(mark.character)}, ${placement.basis}`
    );
    if (markAttachment(markCharacter) === "above") {
      stack = {
        ...stack,
        bounds: withTop(stack.bounds, mark.bounds.yMax + placement.dy),
      };
    }
    if (index > 0) {
      weaknesses.push(
        "Stacked marks are spaced by rule, not drawn as one design."
      );
    }
  }
  if (
    base.bounds.yMax - source.style.metrics.xHeight >
    lineTolerance(source.style)
  ) {
    weaknesses.push(
      "The mark keeps its lowercase shape. Faces often draw a flatter mark over tall letters."
    );
  }
  return {
    advance: base.shape.advance,
    outline: { contours },
    rule: `Composite of ${characterLabel(baseCharacter)} with ${placed.join("; ")}.`,
    weaknesses,
  };
};
