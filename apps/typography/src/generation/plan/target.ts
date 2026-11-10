/** What generation is asked to draw: one glyph, with what it depends on. */
import type { GlyphRef } from "~/typeface/changes";

/** How a glyph can be built from glyphs the face already has. */
export type Recipe =
  | {
      readonly kind: "composite";
      /** The base character, already swapped for a dotless form where one applies. */
      readonly base: number;
      /** Combining marks in the order they stack. */
      readonly marks: readonly number[];
    }
  | {
      readonly kind: "oblique";
      /** Degrees clockwise from upright. */
      readonly angle: number;
      readonly glyphId: number;
    }
  | { readonly kind: "small-capital"; readonly capital: number };

export interface GlyphTarget {
  /** Characters the glyph will be mapped to. Empty for forms reached only through shaping. */
  readonly characters: readonly number[];
  /** Unique within a plan. */
  readonly key: string;
  /** The glyph's name in a built font. */
  readonly name: string;
  /** Keys of targets that have to exist before this one can be built from parts. */
  readonly needs: readonly string[];
  readonly recipe?: Recipe;
  /** Set when the target redraws a glyph the face already has. */
  readonly replaces?: GlyphRef;
  /** The text that shows the glyph, for prompts and labels. */
  readonly text: string;
}

const hex = (character: number) =>
  character.toString(16).toUpperCase().padStart(4, "0");

/** U+00E9 style notation. */
export const characterLabel = (character: number) => `U+${hex(character)}`;

/** The conventional glyph name for a character: uni00E9, or u1F600 beyond the basic plane. */
export const glyphNameFor = (character: number) =>
  character > 0xff_ff ? `u${hex(character)}` : `uni${hex(character)}`;

export const targetKeyFor = (character: number) =>
  characterLabel(character).toLowerCase();
