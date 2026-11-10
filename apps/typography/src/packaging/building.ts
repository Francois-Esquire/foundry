/**
 * The port for producing font files. The app describes what it wants built
 * in domain terms and an engine adapter does the font engineering.
 */
import type { AddedGlyph, GlyphOverride } from "~/typeface/changes";
import type { AxisLocation } from "~/typeface/face";

export type FontFlavor = "ttf" | "woff2";

/** Which part of a font to keep. An absent selection keeps everything. */
export interface SubsetSelection {
  /** Characters to keep. Omit to keep every glyph, mapped or not. */
  readonly characters?: readonly number[];
  /**
   * Feature tags to keep. Omit to keep every feature the kept glyphs need.
   * An empty list removes every feature.
   */
  readonly features?: readonly string[];
}

export interface BuildRequest {
  readonly added: readonly AddedGlyph[];
  readonly faceIndex: number;
  /** Renames the family so a derived font never passes for the original. */
  readonly familyName?: string;
  readonly featureCode: readonly string[];
  readonly flavor?: FontFlavor;
  /** Pins a variable source to one instance before the changes apply. */
  readonly location?: AxisLocation;
  readonly overrides: ReadonlyMap<number, GlyphOverride>;
  /** The source font file, untouched. */
  readonly source: Uint8Array;
  /** Renames the style. A pinned instance needs it: the source names its default. */
  readonly styleName?: string;
  readonly subset?: SubsetSelection;
}

export interface BuiltFont {
  readonly bytes: Uint8Array;
  readonly characterCount: number;
  readonly glyphCount: number;
  /** Notes from the engine, such as glyphs it had to convert. */
  readonly notes: readonly string[];
}

export type Substitution =
  | { readonly kind: "single"; readonly from: string; readonly to: string }
  | {
      readonly kind: "ligature";
      readonly from: readonly string[];
      readonly to: string;
    }
  | {
      readonly kind: "alternate";
      readonly from: string;
      readonly to: readonly string[];
    }
  | {
      readonly kind: "multiple";
      readonly from: string;
      readonly to: readonly string[];
    };

export interface FeatureSummary {
  readonly lookupCount: number;
  readonly scripts: readonly string[];
  /** Substitutions the feature performs, by glyph name. Capped by the engine. */
  readonly substitutions: readonly Substitution[];
  readonly table: "GSUB" | "GPOS";
  readonly tag: string;
  /** True when the feature holds more rules than the summary lists. */
  readonly truncated: boolean;
}

export interface LayoutSummary {
  readonly anchorCount: number;
  readonly features: readonly FeatureSummary[];
  readonly glyphNames: readonly string[];
  readonly kerningPairCount: number;
}

export interface ValidationIssue {
  readonly message: string;
  readonly severity: "error" | "warning";
  readonly table?: string;
}

export interface ValidationReport {
  readonly characterCount: number;
  readonly glyphCount: number;
  readonly issues: readonly ValidationIssue[];
  /** True when the file reloads and no check reported an error. */
  readonly loadable: boolean;
}

export interface FontBuilder {
  build(request: BuildRequest): Promise<BuiltFont>;
  describeLayout(font: Uint8Array, faceIndex?: number): Promise<LayoutSummary>;
  validate(font: Uint8Array): Promise<ValidationReport>;
}

export class BuildError extends Error {
  override readonly name = "BuildError";
}
