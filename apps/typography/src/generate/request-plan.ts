/**
 * Plan, as the Generate place asks for it: the targets for a list of
 * characters in one face, with what each depends on. A character the face
 * already has is planned as a holdout test: it is hidden from everything
 * that draws it, redrawn, and compared with the face's own glyph.
 */
import { markForms } from "~/generation/plan/marks";
import { planCharacters } from "~/generation/plan/plan";
import { type GlyphTarget, targetKeyFor } from "~/generation/plan/target";
import type { GlyphRef } from "~/typeface/changes";
import type { GlyphShape, OpenFace } from "~/typeface/reading";
import { withoutCharacters } from "./hidden-characters";

/** The most characters one run takes. A sheet with more cells draws each too small to extract. */
export const RUN_LIMIT = 24;

export interface RequestPlan {
  /** How many requested characters were left for a later run by the limit. */
  readonly deferred: number;
  /** The face as generation may see it: without the characters under test. */
  readonly face: OpenFace;
  /** Characters the face already has, redrawn as a holdout test. */
  readonly heldOut: readonly number[];
  /** The face's own glyphs for the characters under test, by target key. */
  readonly holdouts: ReadonlyMap<string, GlyphShape>;
  /** Parts first, then the glyphs built from them. */
  readonly targets: readonly GlyphTarget[];
}

/**
 * Plans a request. `glyphFor` says which glyph a character maps to in the
 * project now, counting glyphs the project added: a character that has one
 * is planned as a redrawing of it, so accepting the result replaces that
 * glyph instead of adding a second one for the same character.
 */
export const planRequest = (
  face: OpenFace,
  characters: readonly number[],
  glyphFor: (character: number) => GlyphRef | undefined,
  limit = RUN_LIMIT
): RequestPlan => {
  const asked = [...new Set(characters)];
  const taken = asked.slice(0, limit);
  const existing = new Map<number, GlyphRef>();
  const holdouts = new Map<string, GlyphShape>();
  for (const character of taken) {
    const ref = glyphFor(character);
    if (ref) {
      existing.set(character, ref);
    }
    if (ref?.kind === "source") {
      holdouts.set(targetKeyFor(character), face.glyph(ref.glyphId));
    }
  }
  const heldOut = taken.filter(
    (character) => existing.get(character)?.kind === "source"
  );
  const hidden = withoutCharacters(face, heldOut);
  const { targets } = planCharacters(hidden, taken);
  return {
    deferred: asked.length - taken.length,
    face: hidden,
    heldOut,
    holdouts,
    targets: targets.map((target) => {
      const [character] = target.characters;
      const replaces =
        character === undefined ? undefined : existing.get(character);
      return replaces ? { ...target, replaces } : target;
    }),
  };
};

/** One part a target is built from, and where the part comes from. */
export interface PartNeed {
  readonly character: number;
  /**
   * The character whose glyph in the face draws the part: the part itself,
   * or the spacing form of a combining mark. Undefined when the face has
   * neither, so the part is a target of the same run and is made first.
   */
  readonly drawnBy: number | undefined;
  readonly role: "base" | "mark";
}

/** What a target is built from. Empty for a glyph that has to be drawn whole. */
export const partsOf = (target: GlyphTarget, face: OpenFace): PartNeed[] => {
  const { recipe } = target;
  if (recipe?.kind !== "composite") {
    return [];
  }
  const has = (character: number) =>
    face.glyphForCharacter(character) !== undefined;
  return [
    {
      character: recipe.base,
      drawnBy: has(recipe.base) ? recipe.base : undefined,
      role: "base",
    },
    ...recipe.marks.map(
      (mark): PartNeed => ({
        character: mark,
        drawnBy: markForms(mark).find(has),
        role: "mark",
      })
    ),
  ];
};
