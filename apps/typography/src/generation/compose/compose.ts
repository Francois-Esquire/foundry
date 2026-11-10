/**
 * Compose: the seam where glyphs gain relationships with each other. Today
 * every glyph stands alone. Script-aware composition, such as the layout
 * rules that reach a conjunct or place a mark, will stand behind `Composer`.
 */
import type { OpenFace } from "~/typeface/reading";
import type { GlyphDraft } from "../draft";
import type { GlyphTarget } from "../plan/target";

interface ComposeContext {
  readonly face: OpenFace;
  readonly targets: readonly GlyphTarget[];
}

interface Composition {
  readonly drafts: readonly GlyphDraft[];
  /** OpenType feature code that the composed glyphs need, naming glyphs by name. */
  readonly featureCode: readonly string[];
  /** Relationships that were wanted and not made, in words. */
  readonly notes: readonly string[];
}

export type Composer = (
  drafts: readonly GlyphDraft[],
  context: ComposeContext
) => Composition;

/**
 * Leaves each glyph on its own and says which ones no character reaches, so
 * nobody takes an unmapped glyph for a working one.
 */
export const composeIndependently: Composer = (drafts, { targets }) => {
  const made = new Set(drafts.map((draft) => draft.key));
  const unreached = targets.filter(
    (target) =>
      made.has(target.key) && target.characters.length === 0 && !target.replaces
  );
  return {
    drafts,
    featureCode: [],
    notes: unreached.map(
      (target) =>
        `${target.name} (${target.text}) maps to no character. It needs a layout rule before text can reach it.`
    ),
  };
};
