/**
 * A script extension plan: the glyphs a face needs before a defined part of
 * another writing system works in it, the layout rule each glyph needs, and
 * the words that prove it. The plan is data. Nothing in it is particular to
 * one script: a script brings its own tags, feature names and entries.
 */
import type { GlyphTarget } from "../plan/target";

/** What a glyph needs from layout before text can use it. */
type FormRule =
  /** A letter marks stand on. Reached straight from its character. */
  | { readonly kind: "base" }
  /** One glyph that replaces a run of others, named in text order. */
  | { readonly kind: "conjunct"; readonly parts: readonly string[] }
  /** A letter's joining form: the letter and the joiner become this glyph. */
  | {
      readonly kind: "half-form";
      readonly joiner: string;
      readonly of: string;
    }
  /** A mark with no advance, hung on an anchor above or below its base. */
  | { readonly kind: "mark-above" }
  | { readonly kind: "mark-below" }
  /** A vowel sign with an advance of its own, set before or after the base. */
  | { readonly kind: "vowel-sign-after" }
  | { readonly kind: "vowel-sign-before" };

export type FormRuleKind = FormRule["kind"];

export interface PlannedGlyph {
  /** Characters mapped to the glyph. Empty for a form only layout reaches. */
  readonly characters: readonly number[];
  /** The glyph's name in the built font and in feature code. */
  readonly name: string;
  readonly rule: FormRule;
  /**
   * Set when the glyph is not drawn alone: the syllable that shows it on a
   * known base, which it is then separated from.
   */
  readonly shownIn?: {
    /** The name of the glyph the syllable is drawn on. */
    readonly base: string;
    readonly syllable: string;
  };
  /** The text that shows the glyph, as a sheet cell or a label would. */
  readonly text: string;
}

/** A word and the glyphs it has to shape to, in visual order. */
interface PlannedWord {
  readonly glyphs: readonly string[];
  readonly text: string;
}

/** The OpenType side of a script: its tags, and the feature each rule goes in. */
interface ScriptLayout {
  readonly features: {
    readonly conjunct: string;
    readonly halfForm: string;
    readonly markAbove: string;
    readonly markBelow: string;
  };
  /** OpenType script tags the rules are registered under, for example dev2. */
  readonly tags: readonly string[];
}

export interface ScriptExtensionPlan {
  readonly glyphs: readonly PlannedGlyph[];
  /** The ISO 15924 code, for example Deva. */
  readonly iso15924: string;
  readonly layout: ScriptLayout;
  /** The script's name, for reports. */
  readonly script: string;
  readonly words: readonly PlannedWord[];
}

export class ExtensionPlanError extends Error {
  override readonly name = "ExtensionPlanError";
}

/** The syllables the plan's glyphs are separated from, each once. */
export const plannedSyllables = (plan: ScriptExtensionPlan): string[] => [
  ...new Set(plan.glyphs.flatMap((glyph) => glyph.shownIn?.syllable ?? [])),
];

export const syllableKey = (syllable: string) => `syllable:${syllable}`;

/** A planned glyph's key as a generation target: its glyph name. */
const glyphTarget = (glyph: PlannedGlyph): GlyphTarget => ({
  characters: glyph.characters,
  key: glyph.name,
  name: glyph.name,
  needs: glyph.shownIn ? [syllableKey(glyph.shownIn.syllable)] : [],
  text: glyph.text,
});

/**
 * The generation targets for the sheet cells given, by the text each cell
 * shows: a glyph drawn whole, or a syllable together with the glyphs that are
 * separated from it. A syllable is a target so that it is fitted to its
 * lines; it never becomes a glyph of the face.
 */
export const targetsForCells = (
  plan: ScriptExtensionPlan,
  cells: readonly string[]
): GlyphTarget[] => {
  const shown = new Set(cells);
  const whole = plan.glyphs
    .filter((glyph) => !glyph.shownIn && shown.has(glyph.text))
    .map(glyphTarget);
  const syllables = plannedSyllables(plan)
    .filter((syllable) => shown.has(syllable))
    .map(
      (syllable): GlyphTarget => ({
        characters: [],
        key: syllableKey(syllable),
        name: syllableKey(syllable),
        needs: [],
        text: syllable,
      })
    );
  const separated = plan.glyphs
    .filter((glyph) => glyph.shownIn && shown.has(glyph.shownIn.syllable))
    .map(glyphTarget);
  return [...whole, ...syllables, ...separated];
};

/** The key of the target a cell's text is drawn for, when the plan has one. */
export const cellKeyFor = (
  plan: ScriptExtensionPlan,
  text: string
): string | undefined => {
  const whole = plan.glyphs.find(
    (glyph) => !glyph.shownIn && glyph.text === text
  );
  if (whole) {
    return whole.name;
  }
  return plannedSyllables(plan).includes(text) ? syllableKey(text) : undefined;
};

/** Planned names that a glyph of the source font already has. */
export const nameCollisions = (
  plan: ScriptExtensionPlan,
  sourceGlyphNames: ReadonlySet<string>
): string[] =>
  plan.glyphs
    .map((glyph) => glyph.name)
    .filter((name) => sourceGlyphNames.has(name));
