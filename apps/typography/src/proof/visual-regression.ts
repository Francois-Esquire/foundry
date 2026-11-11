/**
 * The visual regression check. A sample text is set from the source font's
 * own outlines and from the derived font's own outlines, both are rasterised
 * into the same frame, and the pixels are compared one by one. Nothing is
 * tolerated: text made only of unchanged glyphs has to give no difference.
 */
import {
  type Bitmap,
  createBitmap,
  INK_THRESHOLD,
} from "~/generation/raster/bitmap";
import { frameAround, rasterizeOutline } from "~/generation/raster/rasterize";
import type { BuildRequest } from "~/packaging/building";
import type { ShapingSample } from "~/packaging/shaping-retention";
import { fairOptions, keptPart } from "~/packaging/shaping-retention";
import {
  type Bounds,
  type Outline,
  outlineBounds,
  transformOutline,
} from "~/typeface/outline";
import type { OpenFace } from "~/typeface/reading";
import { lineOutline } from "./text-line";

/** What each pixel of a difference picture holds. */
export const PIXEL = {
  both: 1,
  derivedOnly: 3,
  paper: 0,
  sourceOnly: 2,
} as const;

export interface RasterDifference {
  /** Pixels inked in the derived line only. */
  readonly derivedOnly: number;
  /** Pixels inked in either line. */
  readonly inked: number;
  /** One `PIXEL` value per pixel, row by row from the top. */
  readonly picture: Bitmap;
  /** Differing pixels as a share of the inked ones, 0 to 1. 0 when nothing is inked. */
  readonly share: number;
  /** Pixels inked in the source line only. */
  readonly sourceOnly: number;
}

export interface RegressionTest {
  /** Undefined when neither font draws anything for the text. */
  readonly difference: RasterDifference | undefined;
  /**
   * True when the text uses a glyph the build changed or added, so a
   * difference is what the build was asked for.
   */
  readonly expectsChange: boolean;
  /** The sample as written. */
  readonly text: string;
  /**
   * "same": no pixel differs. "changed": pixels differ where the build changed
   * glyphs. "regressed": pixels differ in text made only of unchanged glyphs.
   * "inconclusive": pixels differ in unchanged text, but the build redrew
   * every outline approximately, so rounding cannot be told from a regression.
   * "not-checked": the derived font keeps none of the text.
   */
  readonly verdict:
    | "same"
    | "changed"
    | "regressed"
    | "inconclusive"
    | "not-checked";
}

/**
 * Why a build moves outlines it was not asked to change. Pinning a variable
 * font rounds every interpolated point to a whole unit, and converting
 * PostScript outlines to TrueType refits every curve.
 */
export type Approximation = "pinned" | "converted";

export const approximationOf = (
  source: OpenFace,
  derived: OpenFace,
  request: BuildRequest
): Approximation | undefined => {
  if (request.location !== undefined) {
    return "pinned";
  }
  return source.description.outlineFormat === derived.description.outlineFormat
    ? undefined
    : "converted";
};

/** Pixels per em. Large enough that a one-unit move of a stem crosses a pixel edge somewhere. */
const PIXELS_PER_EM = 96;

const unionBounds = (
  a: Bounds | undefined,
  b: Bounds | undefined
): Bounds | undefined => {
  if (!(a && b)) {
    return a ?? b;
  }
  return {
    xMax: Math.max(a.xMax, b.xMax),
    xMin: Math.min(a.xMin, b.xMin),
    yMax: Math.max(a.yMax, b.yMax),
    yMin: Math.min(a.yMin, b.yMin),
  };
};

/** Rasterises two outlines into one frame and compares them pixel by pixel. */
export const rasterDifference = (
  source: Outline,
  derived: Outline,
  scale: number
): RasterDifference | undefined => {
  const bounds = unionBounds(outlineBounds(source), outlineBounds(derived));
  if (!bounds) {
    return;
  }
  const frame = frameAround(bounds, scale);
  const before = rasterizeOutline(source, frame);
  const after = rasterizeOutline(derived, frame);
  const picture = createBitmap(frame.width, frame.height);
  let sourceOnly = 0;
  let derivedOnly = 0;
  let both = 0;
  for (let index = 0; index < picture.data.length; index += 1) {
    const inSource = (before.data[index] ?? 0) >= INK_THRESHOLD;
    const inDerived = (after.data[index] ?? 0) >= INK_THRESHOLD;
    if (inSource && inDerived) {
      picture.data[index] = PIXEL.both;
      both += 1;
    } else if (inSource) {
      picture.data[index] = PIXEL.sourceOnly;
      sourceOnly += 1;
    } else if (inDerived) {
      picture.data[index] = PIXEL.derivedOnly;
      derivedOnly += 1;
    }
  }
  const inked = both + sourceOnly + derivedOnly;
  return {
    derivedOnly,
    inked,
    picture,
    share: inked === 0 ? 0 : (sourceOnly + derivedOnly) / inked,
    sourceOnly,
  };
};

/** Whether the build changed anything this text is set with. */
const usesChangedGlyphs = (
  request: BuildRequest,
  text: string,
  sourceGlyphIds: readonly number[]
) => {
  const added = new Set(request.added.flatMap((glyph) => glyph.characters));
  return (
    // Feature code can rearrange any text, so nothing is promised once it is there.
    request.featureCode.length > 0 ||
    sourceGlyphIds.some((glyphId) => request.overrides.has(glyphId)) ||
    [...text].some((character) => added.has(character.codePointAt(0) ?? 0))
  );
};

const verdictOf = (
  difference: RasterDifference | undefined,
  expectsChange: boolean,
  approximation: Approximation | undefined
): RegressionTest["verdict"] => {
  if (!difference || difference.sourceOnly + difference.derivedOnly === 0) {
    return "same";
  }
  if (expectsChange) {
    return "changed";
  }
  return approximation ? "inconclusive" : "regressed";
};

export const regressionTest = (
  source: OpenFace,
  derived: OpenFace,
  request: BuildRequest,
  sample: ShapingSample
): RegressionTest => {
  // Every character the derived font holds is drawn, also one the source
  // lacks: an added glyph has to show as a difference.
  const text = keptPart(sample.text, [derived]);
  const options = fairOptions(source, request, sample);
  const expectsChange = usesChangedGlyphs(
    request,
    text,
    source.shape(text, options.source).glyphs.map((glyph) => glyph.glyphId)
  );
  if (text.length === 0) {
    return {
      difference: undefined,
      expectsChange,
      text: sample.text,
      verdict: "not-checked",
    };
  }
  const sourceEm = source.description.metrics.unitsPerEm;
  // Both lines are compared in the source font's units.
  const rescale = sourceEm / derived.description.metrics.unitsPerEm;
  const after = lineOutline(derived, text, options.derived);
  const difference = rasterDifference(
    lineOutline(source, text, options.source),
    rescale === 1
      ? after
      : transformOutline(after, {
          dx: 0,
          dy: 0,
          xx: rescale,
          xy: 0,
          yx: 0,
          yy: rescale,
        }),
    PIXELS_PER_EM / sourceEm
  );
  return {
    difference,
    expectsChange,
    text: sample.text,
    verdict: verdictOf(
      difference,
      expectsChange,
      approximationOf(source, derived, request)
    ),
  };
};
