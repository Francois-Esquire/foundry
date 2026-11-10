/**
 * An export plan says what to build: which faces, which characters, which
 * layout features, and in which format. It is a plain value. Nothing is built
 * until the plan has been resolved against a project and has no problems.
 */
import type { AxisLocation, FaceId } from "~/typeface/face";
import type { FontFlavor } from "./building";

/** One way of naming characters. A selection is the union of its selectors. */
export type CharacterSelector =
  | { readonly kind: "characters"; readonly codePoints: readonly number[] }
  | { readonly kind: "range"; readonly first: number; readonly last: number }
  /** An ISO 15924 script code, for example Deva. */
  | { readonly kind: "script"; readonly script: string }
  /** A Unicode block name, for example Devanagari Extended. */
  | { readonly kind: "block"; readonly block: string }
  /** A BCP 47 language, for example hi. */
  | { readonly kind: "language"; readonly language: string };

export type CharacterSelection =
  | { readonly kind: "everything" }
  | {
      readonly kind: "selected";
      readonly selectors: readonly CharacterSelector[];
    };

export type FeatureSelection =
  /** Every feature the kept glyphs need. */
  | { readonly kind: "needed" }
  /** Only these feature tags. An empty list removes every feature. */
  | { readonly kind: "chosen"; readonly tags: readonly string[] };

/** What to do with a face whose source font is variable. */
export type VariableTreatment =
  /** Export the variable font. Allowed only while the face has no changes. */
  | { readonly kind: "keep-variable" }
  | {
      readonly kind: "pinned";
      readonly location: AxisLocation;
      /** Defaults to the named instance at this location, or to the axis values. */
      readonly styleName?: string;
    };

export interface PlannedFace {
  readonly faceId: FaceId;
  /**
   * Applies when the source is variable. A variable face stays variable by
   * default. A pinned instance is exported at its own location by default,
   * and can be exported as the variable font while it has no changes.
   */
  readonly variable?: VariableTreatment;
}

export interface ExportPlan {
  readonly characters: CharacterSelection;
  readonly faces: readonly PlannedFace[];
  /** The family name for every derived font. Omit to keep each face's own. */
  readonly familyName?: string;
  readonly features: FeatureSelection;
  readonly format: FontFlavor;
}

/**
 * Unicode data the resolver needs. It is supplied by the caller so that
 * packaging does not decide what a script, a block or a language contains.
 */
export interface CharacterLookups {
  charactersOfBlock(block: string): Iterable<number>;
  /** The characters the face's source font maps. */
  charactersOfFace(faceId: FaceId): Iterable<number>;
  charactersOfLanguage(language: string): Iterable<number>;
  charactersOfScript(script: string): Iterable<number>;
}
