/**
 * The overlay drawing: recovered outlines laid over the evidence they came
 * from, as one SVG in evidence pixels.
 */
import { toDataUri } from "~/generation/raster/image-codec";
import { outlineToPath } from "~/typeface/outline";
import type { Evidence } from "../evidence/evidence";
import { outlineOnEvidence } from "../recovery/correspondence";
import type { RecoveredLetter } from "../recovery/recover";

/** Carbon blue, the colour of anything made after the source. */
const CARBON = "#1f3bd0";

export const overlaySvg = (
  evidence: Evidence,
  letters: readonly RecoveredLetter[]
): string => {
  const paths = letters.map(
    ({ candidate, correspondence }) =>
      `<path data-glyph="${candidate.name}" d="${outlineToPath(outlineOnEvidence(candidate.outline, correspondence))}"/>`
  );
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${evidence.width} ${evidence.height}" width="${evidence.width}" height="${evidence.height}">`,
    `<image href="${toDataUri(evidence.file)}" width="${evidence.width}" height="${evidence.height}"/>`,
    `<g fill="${CARBON}" fill-opacity="0.25" stroke="${CARBON}" stroke-width="1" vector-effect="non-scaling-stroke">`,
    ...paths,
    "</g>",
    "</svg>",
  ].join("\n");
};
