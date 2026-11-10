/**
 * What a revision is called in the history. A revision that accepted a
 * candidate is labelled with the glyph's name, such as uni004E, which says
 * little: when the candidate draws one character the interface's own type
 * can print, the character leads the label.
 */
import type { Revision } from "~/typeface/changes";
import type { Candidate } from "~/typeface/project";

/** The last character the interface's own type is sure to draw. */
const LAST_INTERFACE_CHARACTER = 0x02_4f;
const FIRST_VISIBLE_CHARACTER = 0x21;

export const revisionTitle = (
  revision: Revision,
  candidates: readonly Candidate[]
): string => {
  const accepted =
    revision.accepts === undefined
      ? undefined
      : candidates.find((candidate) => candidate.id === revision.accepts);
  const [character, ...others] = accepted?.characters ?? [];
  return accepted &&
    character !== undefined &&
    others.length === 0 &&
    character >= FIRST_VISIBLE_CHARACTER &&
    character <= LAST_INTERFACE_CHARACTER
    ? `Accept ${String.fromCodePoint(character)}, ${accepted.name}`
    : revision.label;
};
