/**
 * A glyph on its way to becoming a candidate: in font units, with the story
 * of how it was made. Every strategy's output reaches this shape, and the
 * later stages work on nothing else.
 */
import type { Outline } from "~/typeface/outline";

export interface GlyphDraft {
  readonly advance: number;
  /** The key of the target this draft answers. */
  readonly key: string;
  /** The rule or route that made the draft, in words a person can check. */
  readonly madeBy: string;
  readonly outline: Outline;
  /** What the route is known to get wrong. */
  readonly weaknesses: readonly string[];
}
