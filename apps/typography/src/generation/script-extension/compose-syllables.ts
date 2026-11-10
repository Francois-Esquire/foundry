/**
 * The Compose stage for a script extension: every syllable draft is replaced
 * by the glyphs the plan separates from it. Nothing is positioned here. The
 * stages after Compose know only Latin spacing and would move a glyph with
 * no advance or with a hook over its neighbour, so spacing, anchors and
 * layout rules are made from the finished candidates, in `settle.ts`.
 */
import type { Outline } from "~/typeface/outline";
import type { Composer } from "../compose/compose";
import type { GlyphDraft } from "../draft";
import { spaceGlyph } from "../normalise/spacing";
import type { StyleReference } from "../style/reference";
import { readOnLines, snapToHeadline } from "./glyph-lines";
import type { HeadlineLines } from "./headline-lines";
import {
  type PlannedGlyph,
  plannedSyllables,
  type ScriptExtensionPlan,
  syllableKey,
} from "./plan";
import {
  type SeparablePart,
  type SeparatedPiece,
  type SyllablePart,
  separateSyllable,
} from "./separate";

export interface SyllableComposition {
  readonly lines: HeadlineLines;
  /** Outlines of glyphs made on earlier sheets, by name: the known bases. */
  readonly made: ReadonlyMap<string, Outline>;
  /** Told of each piece as it is cut, with where its base's stem stood. */
  readonly onSeparated: (piece: SeparatedPiece, syllable: string) => void;
  readonly plan: ScriptExtensionPlan;
  readonly style: StyleReference;
}

const PART_WORDS: Readonly<Record<SeparablePart, string>> = {
  "half-form":
    "the half form on the left of the conjunct, with its share of the headline",
  "mark-above": "the mark above the headline",
  "mark-below": "the mark below the baseline",
  "vowel-sign-after":
    "the vowel sign after the base: its stem, its share of the headline and any hook over it",
  "vowel-sign-before":
    "the vowel sign before the base: its stem, its share of the headline and its hook over it",
};

const PART_WEAKNESSES: Readonly<Record<SeparablePart, string>> = {
  "half-form":
    "The joining stroke was cut square where it met the base it was drawn on, and its length suits that base.",
  "mark-above":
    "It is placed where it sat over the base it was drawn on, and was traced again after cutting.",
  "mark-below":
    "It is placed where it sat under the base it was drawn on, and was traced again after cutting.",
  "vowel-sign-after":
    "Any hook is as long as the base it was drawn on is wide. It was traced again after cutting.",
  "vowel-sign-before":
    "The hook is as long as the base it was drawn on is wide. It was traced again after cutting.",
};

const isSeparable = (
  glyph: PlannedGlyph
): glyph is PlannedGlyph & { rule: { kind: SeparablePart } } =>
  glyph.rule.kind !== "base" && glyph.rule.kind !== "conjunct";

/** How wide a base is from the left edge of its body to the right end of its headline. */
const baseWidthOf = (
  outline: Outline | undefined,
  lines: HeadlineLines
): number | undefined => {
  const read = outline && readOnLines(snapToHeadline(outline, lines), lines);
  return read?.bodyLeft === undefined
    ? undefined
    : read.headline.right - read.bodyLeft;
};

export const composeSyllables =
  ({ lines, made, onSeparated, plan, style }: SyllableComposition): Composer =>
  (drafts) => {
    const outlines = new Map(made);
    for (const draft of drafts) {
      outlines.set(draft.key, draft.outline);
    }
    const syllables = new Map(
      plannedSyllables(plan).map((syllable) => [
        syllableKey(syllable),
        syllable,
      ])
    );
    const composed: GlyphDraft[] = [];
    const notes: string[] = [];
    for (const draft of drafts) {
      const syllable = syllables.get(draft.key);
      if (syllable === undefined) {
        composed.push(draft);
        continue;
      }
      const parts = plan.glyphs
        .filter((glyph) => glyph.shownIn?.syllable === syllable)
        .filter(isSeparable)
        .map(
          (glyph): SyllablePart => ({
            baseWidth:
              glyph.rule.kind === "half-form"
                ? baseWidthOf(outlines.get(glyph.shownIn?.base ?? ""), lines)
                : undefined,
            kind: glyph.rule.kind,
            name: glyph.name,
          })
        );
      const separation = separateSyllable(draft.outline, parts, lines);
      for (const piece of separation.pieces) {
        onSeparated(piece, syllable);
        const spaced = spaceGlyph(piece.outline, style);
        composed.push({
          advance: spaced.advance,
          key: piece.name,
          madeBy: `Separated from the generated syllable ${syllable}: ${PART_WORDS[piece.kind]}. The syllable was ${draft.madeBy.charAt(0).toLowerCase()}${draft.madeBy.slice(1)}`,
          outline: spaced.outline,
          weaknesses: [...draft.weaknesses, PART_WEAKNESSES[piece.kind]],
        });
      }
      notes.push(
        ...separation.failures.map(
          (failure) =>
            `${failure.name} was not separated from ${syllable}. ${failure.reason}`
        )
      );
    }
    return { drafts: composed, featureCode: [], notes };
  };
