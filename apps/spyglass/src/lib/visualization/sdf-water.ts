import { nominalDepth } from "./geology";

/**
 * The SDF trial's water: the seabed seen through the true path of light in
 * the water, read as the depth the geology preview's optics are calibrated
 * over. Seen straight down the path is the water's depth, so the palette
 * holds top-down; seen at a slant the path is longer, so a slanted view
 * reads deeper and a cliff's face sinks into the blue as it goes down.
 *
 * With an orthographic camera every view ray meets the flat water at one
 * angle, so the refraction is one ratio a frame: the ray leaves the
 * surface toward the vertical by Snell's law, and its path to a point
 * `D` world units under the water is `D / cos θt`.
 */

/** Water's refractive index. */
const waterIndex = 1.333;

/** The cosine of the refracted ray's angle off the vertical, for a view ray at `incidence` radians off it. */
export function refractedCosine(incidence: number): number {
  const sine = Math.sin(incidence) / waterIndex;
  return Math.sqrt(Math.max(0, 1 - sine * sine));
}

/**
 * The nominal depth whose optics a point `below` world units under the
 * water takes, seen at `incidence` radians off the vertical: the refracted
 * path's length, read back through the elevation contract.
 */
export function pathDepth(
  below: number,
  incidence: number,
  exaggeration: number
): number {
  const path = Math.max(0, below) / refractedCosine(incidence);
  return nominalDepth(-path / exaggeration);
}
