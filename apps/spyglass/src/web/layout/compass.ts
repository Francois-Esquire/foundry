import type { SpyglassData } from "../data/types";

/** The compass rose's centre, in map units: at the chart's north-east corner. */
export function compassCentre(data: Pick<SpyglassData, "height" | "width">) {
  return { x: data.width / 2 - 88, y: -data.height / 2 + 94 };
}

/** The compass letter's place, in map units: the "N" sits this far north of the centre. */
export const compassLetterLift = 43;

/**
 * What the compass rose covers, in map units: its points, 35 units from the
 * centre, and the "N" above them. Names that would sit on it keep clear.
 */
export function compassBox(data: Pick<SpyglassData, "height" | "width">) {
  const { x, y } = compassCentre(data);
  return { east: x + 35, north: y - 53, south: y + 35, west: x - 35 };
}
