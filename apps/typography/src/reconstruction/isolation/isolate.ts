/**
 * Lettering isolation: from the upright view of a region to a clean ink map
 * and the letters in it, line by line.
 */
import { removeGuideLines } from "~/generation/extraction/guides";
import type { Bitmap, PixelBox, RasterImage } from "~/generation/raster/bitmap";
import { INK_THRESHOLD } from "~/generation/raster/bitmap";
import { findLetters, type LetteringLine, type LetterOptions } from "./letters";
import { findPieces, type PieceOptions } from "./pieces";
import {
  type Separation,
  type SeparationOptions,
  separateLettering,
} from "./separate";

/** What counts as a ruled line, in pixels of the view. */
interface RuledLines {
  /** A rule may be hidden behind lettering for this long and still be one line. */
  readonly maximumGap: number;
  readonly maximumThickness: number;
  readonly minimumLength: number;
}

export interface IsolationOptions
  extends LetterOptions,
    PieceOptions,
    SeparationOptions {
  /**
   * Take out ruled lines before looking for letters, as on lined paper.
   * `true` sizes them from the view: long, thin and nearly level or upright.
   * Only the thin stretches of a rule are removed, so a stroke that crosses
   * one is nicked, not cut through, and a stretch of rule that runs under
   * lettering can stay joined to it. The sizes matter a great deal: a
   * thickness a pixel too small leaves rules in, a pixel too large takes
   * strokes out. Off when absent.
   */
  readonly ruledLines?: RuledLines | boolean;
}

/** A rule spans at least this share of the view and is at most this share of it thick. */
const RULE_LENGTH = 0.12;
const RULE_THICKNESS = 0.025;
const RULE_GAP = 0.04;

const rulesFor = (
  view: RasterImage,
  ruledLines: RuledLines | true
): RuledLines =>
  ruledLines === true
    ? {
        maximumGap: RULE_GAP * view.width,
        maximumThickness: Math.max(3, RULE_THICKNESS * view.height),
        minimumLength: RULE_LENGTH * view.width,
      }
    : ruledLines;

export interface Isolation {
  /**
   * The cleaned ink map. Edges keep their grey levels, with 128 on the
   * boundary, so a tracer can place them finer than a pixel.
   */
  readonly ink: Bitmap;
  readonly lines: readonly LetteringLine[];
  /** How many ruled lines were taken out. 0 when that was not asked for. */
  readonly rulesRemoved: number;
  /** How the lettering was told from the background. */
  readonly separation: Omit<Separation, "ink">;
  readonly specksRemoved: number;
  /** Pieces of ink that sit on no line of lettering. */
  readonly stray: readonly PixelBox[];
  /** The usual stroke thickness of the lettering, in pixels. */
  readonly strokeThickness: number;
}

/** Isolates the lettering in the upright view of a region. */
export const isolateLettering = (
  view: RasterImage,
  options: IsolationOptions = {}
): Isolation => {
  const { ink: separated, ...separation } = separateLettering(view, options);
  const rules = options.ruledLines
    ? removeGuideLines(separated, {
        ...rulesFor(view, options.ruledLines),
        threshold: INK_THRESHOLD,
      })
    : { bitmap: separated, removed: 0 };
  const pieces = findPieces(rules.bitmap, options);
  const { lines, stray } = findLetters(pieces, options);
  return {
    ink: pieces.ink,
    lines,
    rulesRemoved: rules.removed,
    separation,
    specksRemoved: pieces.specksRemoved,
    stray,
    strokeThickness: pieces.strokeThickness,
  };
};

/** The clean two-level image: every pixel is lettering (255) or background (0). */
export const twoLevel = (ink: Bitmap): Bitmap => ({
  data: ink.data.map((value) => (value >= INK_THRESHOLD ? 255 : 0)),
  height: ink.height,
  width: ink.width,
});
