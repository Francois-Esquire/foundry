/**
 * Separates the parts of a syllable drawn on a known base. A model asked for
 * a vowel sign alone attaches it to a letter, so the sign is asked for on a
 * base instead and cut out here: the headline is found, and each part is
 * taken by where it sits against the headline and the base.
 *
 * The cutting is done on a picture of the syllable and the pieces are traced
 * again, so a sheet that arrived as pixels and one that arrived as curves are
 * handled the same way.
 */
import {
  type Outline,
  outlineBounds,
  transformOutline,
} from "~/typeface/outline";
import { labelComponents } from "../extraction/components";
import { type Bitmap, createBitmap, INK_THRESHOLD } from "../raster/bitmap";
import {
  frameAround,
  rasterizeOutline,
  tracedToOutline,
} from "../raster/rasterize";
import { contourTracer } from "../vector/trace";
import type { Vectorizer } from "../vector/vectorizer";
import {
  findHeadline,
  findMainStem,
  type HeadlineBand,
  inkUnderHeadline,
  isInk,
  partsUnderHeadline,
  type Span,
} from "./headline";
import type { HeadlineLines } from "./headline-lines";
import type { FormRuleKind } from "./plan";

/** The rules whose glyphs can be cut from a syllable. */
export type SeparablePart = Exclude<FormRuleKind, "base" | "conjunct">;

export interface SyllablePart {
  /**
   * For a half form: how wide the base it leans on is, from the left edge of
   * the ink under its headline to the right end of its headline, in font
   * units on the model's lines.
   */
  readonly baseWidth?: number;
  readonly kind: SeparablePart;
  readonly name: string;
}

export interface SeparatedPiece {
  /**
   * For a mark: where the base's main stem stood, measured from the left
   * edge of the mark's ink. The mark's anchor is put there.
   */
  readonly attachment?: number;
  readonly kind: SeparablePart;
  readonly name: string;
  /**
   * In font units on the model's lines: the syllable's headline top is at
   * the model's, its baseline at 0, and x runs from the left end of its
   * headline.
   */
  readonly outline: Outline;
}

export interface Separation {
  readonly failures: readonly {
    readonly name: string;
    readonly reason: string;
  }[];
  readonly pieces: readonly SeparatedPiece[];
}

/** Pixels from the baseline to the top of the headline in the working picture. */
const PIXELS_PER_HEADLINE = 480;
/** The share of the headline's thickness, under it, where strokes are still rounding into it. */
const JOIN_ROUNDING = 0.25;
/** How far a part cut off above the headline reaches down into it, so it overlaps the headline it is set on. */
const TAB_DEPTH = 0.3;
/** Ink this share of the headline's thickness under the baseline is below it. */
const BELOW_BASELINE = 0.25;
/** How far either side of where the base should start the cut is looked for, as a share of the base's width. */
const CUT_SEARCH = 0.2;

type Mask = (x: number, y: number) => boolean;

type Cut =
  | { readonly mask: Mask }
  | { readonly mask?: undefined; readonly reason: string };

interface Picture {
  readonly band: HeadlineBand;
  /** The pixel row of the baseline. */
  readonly baseline: number;
  readonly bitmap: Bitmap;
  /** Pixels to one font unit on the model's lines. */
  readonly pixelsPerUnit: number;
  readonly thickness: number;
}

/** Ink over the headline, with a tab into it wherever that ink stands on it. */
const overHeadline = ({ band, bitmap, thickness }: Picture): Mask => {
  const tab = Math.round(TAB_DEPTH * thickness);
  return (x, y) =>
    y < band.top || (y < band.top + tab && isInk(bitmap, x, band.top - 1));
};

/** The middle of the clear paper between two neighbouring parts. */
const between = (left: Span, right: Span) =>
  Math.round((left.end + right.start) / 2);

const vowelSignCut = (picture: Picture, side: "after" | "before"): Cut => {
  const parts = partsUnderHeadline(
    picture.bitmap,
    picture.band,
    Math.round(JOIN_ROUNDING * picture.thickness)
  );
  const [first, second] = parts;
  const last = parts.at(-1);
  const beforeLast = parts.at(-2);
  if (!(first && second && last && beforeLast)) {
    return {
      reason:
        "The vowel sign's stem touches the base under the headline, so there is no clear paper to cut along.",
    };
  }
  const over = overHeadline(picture);
  if (side === "after") {
    const cut = between(beforeLast, last);
    return { mask: (x, y) => x >= cut || over(x, y) };
  }
  const cut = between(first, second);
  return { mask: (x, y) => x < cut || over(x, y) };
};

/**
 * Ink below the baseline. A mark drawn clear of the base is taken whole, as
 * the pieces of ink that do not touch the headline's. One that touches the
 * base is cut off level a little under the baseline.
 */
const belowBaselineCut = (picture: Picture): Cut => {
  const { band, baseline, bitmap, thickness } = picture;
  const labelled = labelComponents(bitmap, INK_THRESHOLD);
  const ownerAt = (x: number, y: number) =>
    labelled.labels[y * labelled.width + x] ?? 0;
  const body = ownerAt(
    Math.round((band.left + band.right) / 2),
    Math.round((band.top + band.bottom) / 2)
  );
  const apart = new Set(
    labelled.components
      .filter(
        (component) =>
          component.id !== body &&
          (component.box.top + component.box.bottom) / 2 > baseline
      )
      .map((component) => component.id)
  );
  if (apart.size > 0) {
    return { mask: (x, y) => apart.has(ownerAt(x, y)) };
  }
  const level = baseline + Math.round(BELOW_BASELINE * thickness);
  for (let y = level; y < bitmap.height; y += 1) {
    for (let x = 0; x < bitmap.width; x += 1) {
      if (isInk(bitmap, x, y)) {
        return { mask: (_, row) => row >= level };
      }
    }
  }
  return { reason: "No ink was found below the baseline." };
};

/**
 * The half form on the left of a conjunct. The known base on the right is as
 * wide as it is when drawn alone, which says about where it starts; the cut
 * is made at the thinnest ink near there, which is the stroke that joins the
 * two.
 */
const halfFormCut = (picture: Picture, baseWidth: number | undefined): Cut => {
  if (baseWidth === undefined) {
    return {
      reason:
        "The base the half form leans on has not been made, so where it starts is not known.",
    };
  }
  const { band, bitmap } = picture;
  const width = baseWidth * picture.pixelsPerUnit;
  const expected = band.right - width;
  const reach = CUT_SEARCH * width;
  const from = Math.max(band.left + 1, Math.round(expected - reach));
  const to = Math.min(band.right - 1, Math.round(expected + reach));
  const ink = inkUnderHeadline(bitmap, band).slice(from, to + 1);
  if (ink.length === 0) {
    return {
      reason:
        "The syllable is not wide enough to hold the base it was drawn on.",
    };
  }
  // The joining stroke is a stretch of columns about equally thin. Among
  // them the one nearest to where the base should start is taken, so the
  // cut does not wander along the stroke with the noise of a picture.
  const thin = Math.min(...ink) + JOIN_ROUNDING * picture.thickness;
  let cut = from;
  let nearest = Number.POSITIVE_INFINITY;
  for (const [offset, amount] of ink.entries()) {
    const distance = Math.abs(from + offset - expected);
    if (amount <= thin && distance < nearest) {
      cut = from + offset;
      nearest = distance;
    }
  }
  const edge = cut;
  return { mask: (x) => x < edge };
};

const cutFor = (picture: Picture, part: SyllablePart): Cut => {
  switch (part.kind) {
    case "vowel-sign-after":
      return vowelSignCut(picture, "after");
    case "vowel-sign-before":
      return vowelSignCut(picture, "before");
    case "mark-above":
      return { mask: overHeadline(picture) };
    case "mark-below":
      return belowBaselineCut(picture);
    default:
      return halfFormCut(picture, part.baseWidth);
  }
};

const cutOut = (bitmap: Bitmap, mask: Mask): Bitmap => {
  const piece = createBitmap(bitmap.width, bitmap.height);
  for (let y = 0; y < bitmap.height; y += 1) {
    for (let x = 0; x < bitmap.width; x += 1) {
      if (mask(x, y) && isInk(bitmap, x, y)) {
        piece.data[y * bitmap.width + x] = 255;
      }
    }
  }
  return piece;
};

/**
 * Cuts the named parts out of one syllable. Each piece comes back on the
 * model's lines, whatever size the syllable was drawn at: it is scaled about
 * the baseline until the syllable's own headline sits on the model's.
 */
export const separateSyllable = (
  syllable: Outline,
  parts: readonly SyllablePart[],
  lines: HeadlineLines,
  vectorizer: Vectorizer = contourTracer
): Separation => {
  const none = (reason: string): Separation => ({
    failures: parts.map((part) => ({ name: part.name, reason })),
    pieces: [],
  });
  const bounds = outlineBounds(syllable);
  if (!bounds) {
    return none("The syllable has no outline.");
  }
  const frame = frameAround(bounds, PIXELS_PER_HEADLINE / lines.headlineTop);
  const bitmap = rasterizeOutline(syllable, frame);
  const band = findHeadline(bitmap, lines.headlineThickness * frame.scale);
  const headlineTop = band && frame.top - band.top / frame.scale;
  if (!(band && headlineTop && headlineTop > 0)) {
    return none("No headline was found in the syllable.");
  }
  const fit = lines.headlineTop / headlineTop;
  const picture: Picture = {
    band,
    baseline: Math.round(frame.top * frame.scale),
    bitmap,
    pixelsPerUnit: frame.scale / fit,
    thickness: band.bottom - band.top,
  };
  const origin = frame.left + band.left / frame.scale;
  const stem = findMainStem(bitmap, band);
  const stemAxis =
    stem && ((stem.start + stem.end) / 2 - band.left) / frame.scale;
  const onLines = (traced: Outline): Outline =>
    transformOutline(transformOutline(traced, tracedToOutline(frame)), {
      dx: -origin * fit,
      dy: 0,
      xx: fit,
      xy: 0,
      yx: 0,
      yy: fit,
    });
  const failures: { name: string; reason: string }[] = [];
  const pieces: SeparatedPiece[] = [];
  for (const part of parts) {
    const cut = cutFor(picture, part);
    const outline = cut.mask
      ? onLines(vectorizer.trace(cutOut(bitmap, cut.mask)))
      : undefined;
    const left = outline && outlineBounds(outline)?.xMin;
    if (!outline || left === undefined) {
      failures.push({
        name: part.name,
        reason: cut.mask ? "The cut left no ink." : cut.reason,
      });
      continue;
    }
    const isMark = part.kind === "mark-above" || part.kind === "mark-below";
    pieces.push({
      attachment:
        isMark && stemAxis !== undefined ? stemAxis * fit - left : undefined,
      kind: part.kind,
      name: part.name,
      outline,
    });
  }
  return { failures, pieces };
};
