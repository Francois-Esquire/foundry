/**
 * What the page shows of a script extension: the glyphs the project holds
 * for it, each with the plan's entry, and the planned glyphs it lacks. It is
 * read from the project's glyphs, so it is the same whoever made the run.
 */
import type {
  PlannedGlyph,
  ScriptExtensionPlan,
} from "~/generation/script-extension/plan";
import type { AddedGlyph } from "~/typeface/changes";

/** A glyph of the project with the plan's entry for it. */
export interface ShownGlyph extends AddedGlyph {
  readonly planned: PlannedGlyph;
}

export interface ShownExtension {
  /** In the plan's order. */
  readonly glyphs: readonly ShownGlyph[];
  /** The planned glyphs these glyphs lack. */
  readonly missing: readonly PlannedGlyph[];
  readonly plan: ScriptExtensionPlan;
}

/** Pairs glyphs with the plan by name. A glyph the plan does not name is not part of the extension. */
export const shownExtension = (
  added: readonly AddedGlyph[],
  plan: ScriptExtensionPlan
): ShownExtension => {
  const byName = new Map(added.map((glyph) => [glyph.name, glyph]));
  return {
    glyphs: plan.glyphs.flatMap((planned) => {
      const glyph = byName.get(planned.name);
      return glyph ? [{ ...glyph, planned }] : [];
    }),
    missing: plan.glyphs.filter((planned) => !byName.has(planned.name)),
    plan,
  };
};
