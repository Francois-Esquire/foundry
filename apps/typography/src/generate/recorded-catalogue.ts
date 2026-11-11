/** How the Generate place words an entry of the recorded catalogue. */
import type { RecordedEntry } from "~/generation/strategies/recorded/catalogue";
import { outputLabel } from "~/generation/strategies/recorded/manifest";

/** How an entry reads in a list: the run, which output, and the model that made it. */
export const entryLabel = ({ manifest, output }: RecordedEntry) =>
  `${manifest.id}, ${outputLabel(output)}: ${output.synthetic ? "synthetic sheet, no model" : output.model}`;

/**
 * Why a recorded run's glyphs are not compared with a face's own, when they
 * are not. The face's glyph is the answer only to a run made from that face.
 */
export const comparisonNote = (
  { madeFrom }: RecordedEntry,
  face: { readonly familyName: string; readonly fullName: string }
): string | undefined => {
  if (!madeFrom) {
    return "This run was not made from a font, so its glyphs are not compared with this face's own.";
  }
  if (madeFrom.family === face.familyName) {
    return;
  }
  const source = [madeFrom.family, madeFrom.style].filter(Boolean).join(" ");
  return `This run was made from ${source}, not from ${face.fullName}. Its glyphs were drawn to match that face and are not compared with this one's own.`;
};
