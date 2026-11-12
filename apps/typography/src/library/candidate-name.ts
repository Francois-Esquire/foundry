import type { GlyphTarget } from "~/generation/plan/target";
import { formatCodePoint } from "~/lib/code-point";

/** The last character the interface's own type is sure to draw. */
const LAST_INTERFACE_CHARACTER = 0x02_4f;
const FIRST_VISIBLE_CHARACTER = 0x21;

/**
 * The character a target draws, when the interface's own type can print it.
 * Anything else is named by its code point, so no system fallback font ever
 * stands in for a letterform.
 */
export const literalOf = (target: GlyphTarget): string | undefined => {
  const [character, ...others] = target.characters;
  return character !== undefined &&
    others.length === 0 &&
    character >= FIRST_VISIBLE_CHARACTER &&
    character <= LAST_INTERFACE_CHARACTER
    ? target.text
    : undefined;
};

/** What to call the glyph in a control: its character, else its code point, else its glyph name. */
export const spokenName = (target: GlyphTarget): string => {
  const [character] = target.characters;
  return (
    literalOf(target) ??
    (character === undefined ? target.name : formatCodePoint(character))
  );
};
