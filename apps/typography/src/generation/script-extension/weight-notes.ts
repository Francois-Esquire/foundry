/** How the new letters' weight compares with the face's, as sentences. */
import type { ScriptExtension } from "./extend";

const percent = (share: number) => `${Math.round(share * 100)}%`;

const compared = (
  what: string,
  measured: number | undefined,
  inFace: number,
  faceWhat: string
) =>
  measured === undefined
    ? `${what}: not measured.`
    : `${what}: ${Math.round(measured)} units, against ${Math.round(inFace)} for ${faceWhat} (${percent(measured / inFace)}).`;

/**
 * The measured stroke thicknesses of the new letters beside the face's own.
 * The height rule sizes the letters, so their weight is whatever the model
 * drew at that size, and these figures say what it came to.
 */
export const weightNotes = ({
  weight,
}: Pick<ScriptExtension, "weight">): string[] => [
  compared(
    "Headline thickness of the new letters",
    weight.headline,
    weight.levelStroke,
    "the face's level strokes"
  ),
  compared(
    "Upright stem of the new letters",
    weight.stem,
    weight.uprightStroke,
    "the face's upright stems"
  ),
  ...(weight.separatedHeadline !== undefined && weight.headline !== undefined
    ? [
        `Headline thickness of the glyphs separated from syllables: ${Math.round(weight.separatedHeadline)} units, against ${Math.round(weight.headline)} for the letters drawn whole. Where the two differ by more than a few units, a step shows under the headline.`,
      ]
    : []),
];
