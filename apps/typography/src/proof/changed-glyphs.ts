/**
 * The glyphs a build changed or added, each found again in the derived font
 * so the list shows what the file really holds.
 */
import type { BuildRequest } from "~/packaging/building";
import type { GlyphOverride } from "~/typeface/changes";
import type { Outline } from "~/typeface/outline";
import type { Provenance } from "~/typeface/provenance";
import type { OpenFace } from "~/typeface/reading";

export type GlyphChange =
  | "redrawn"
  | "respaced"
  | "redrawn-and-respaced"
  | "added";

/**
 * "present": the glyph was found in the derived font. "untraceable": a
 * subset renumbers glyphs, and none of this glyph's characters leads to it
 * in the file. The selection may have left it out, or layout rules may still
 * reach it, as they do a ligature; the file cannot be asked which.
 */
type GlyphPresence = "present" | "untraceable";

export interface ChangedGlyph {
  readonly change: GlyphChange;
  /** Characters that map to the glyph. Empty for ligatures and alternates. */
  readonly characters: readonly number[];
  readonly key: string;
  /** The glyph's name in the source font, or the name it was added under. */
  readonly name: string;
  /** The outline as the derived font holds it. Undefined unless the glyph is present. */
  readonly outline: Outline | undefined;
  readonly presence: GlyphPresence;
  /** Where a new outline came from. Undefined when only the advance changed. */
  readonly provenance: Provenance | undefined;
}

interface Found {
  readonly outline: Outline | undefined;
  readonly presence: GlyphPresence;
}

const changeOf = (override: GlyphOverride): GlyphChange => {
  if (override.outline && override.advance !== undefined) {
    return "redrawn-and-respaced";
  }
  return override.outline ? "redrawn" : "respaced";
};

const present = (derived: OpenFace, glyphId: number): Found => ({
  outline: derived.glyph(glyphId).outline,
  presence: "present",
});

const byCharacter = (
  derived: OpenFace,
  characters: readonly number[]
): Found => {
  for (const character of characters) {
    const glyphId = derived.glyphForCharacter(character);
    if (glyphId !== undefined) {
      return present(derived, glyphId);
    }
  }
  return { outline: undefined, presence: "untraceable" };
};

export const changedGlyphs = (
  request: BuildRequest,
  source: OpenFace,
  derived: OpenFace
): ChangedGlyph[] => {
  // Without a character selection every glyph keeps its place, and added
  // glyphs follow the source's in the order they were added.
  const renumbered = request.subset?.characters !== undefined;
  const taken = new Set(request.added.flatMap((glyph) => glyph.characters));
  const overridden = [...request.overrides.entries()]
    .sort(([a], [b]) => a - b)
    .map(([glyphId, override]): ChangedGlyph => {
      const characters = source.charactersForGlyph(glyphId);
      return {
        change: changeOf(override),
        characters,
        key: `s:${glyphId}`,
        name: source.glyphName(glyphId),
        provenance: override.provenance,
        ...(renumbered
          ? byCharacter(
              derived,
              // A character an added glyph took over no longer leads here.
              characters.filter((character) => !taken.has(character))
            )
          : present(derived, glyphId)),
      };
    });
  const added = request.added.map(
    (glyph, index): ChangedGlyph => ({
      change: "added",
      characters: glyph.characters,
      key: `a:${glyph.key}`,
      name: glyph.name,
      provenance: glyph.provenance,
      ...(renumbered
        ? byCharacter(derived, glyph.characters)
        : present(derived, source.description.glyphCount + index)),
    })
  );
  return [...overridden, ...added];
};
