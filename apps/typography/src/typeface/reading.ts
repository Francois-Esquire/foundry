/**
 * The port for reading a font file. The typeface model never touches a font
 * parser directly: an adapter opens the bytes and answers in domain terms.
 */
import type { AxisLocation, FaceDescription } from "./face";
import type { Outline } from "./outline";

export interface GlyphShape {
  readonly advance: number;
  readonly outline: Outline;
}

export type TextDirection = "ltr" | "rtl";

export interface ShapeOptions {
  readonly direction?: TextDirection;
  /** OpenType feature settings such as { liga: false, ss01: true }. */
  readonly features?: Readonly<Record<string, boolean | number>>;
  /** BCP 47 language, for example hi. */
  readonly language?: string;
  readonly location?: AxisLocation;
  /** ISO 15924 script, for example Deva. Guessed from the text when absent. */
  readonly script?: string;
}

export interface ShapedGlyph {
  /** Index of the first UTF-16 code unit this glyph came from. */
  readonly cluster: number;
  readonly glyphId: number;
  readonly xAdvance: number;
  readonly xOffset: number;
  readonly yAdvance: number;
  readonly yOffset: number;
}

export interface ShapedRun {
  readonly direction: TextDirection;
  readonly glyphs: readonly ShapedGlyph[];
}

/** One face of an opened font file. Call `close` when finished with it. */
export interface OpenFace {
  /** Every mapped Unicode code point, ascending. */
  characters(): Uint32Array;
  /** Characters that map to this glyph. Empty for ligatures and alternates. */
  charactersForGlyph(glyphId: number): readonly number[];
  close(): void;
  readonly description: FaceDescription;
  glyph(glyphId: number, location?: AxisLocation): GlyphShape;
  /** The glyph a character maps to before any substitution. */
  glyphForCharacter(codePoint: number): number | undefined;
  glyphName(glyphId: number): string;
  shape(text: string, options?: ShapeOptions): ShapedRun;
}

export class UnreadableFontError extends Error {
  override readonly name = "UnreadableFontError";
}

export interface FontReader {
  /** How many faces the file holds. Throws UnreadableFontError for a bad file. */
  faceCount(bytes: Uint8Array): number;
  open(bytes: Uint8Array, index?: number): OpenFace;
}
