import { fileFootprint } from "../../lib/file-placement";

export function footprint(size: number) {
  return fileFootprint(size);
}

export function attraction(strength: number) {
  return Math.log2(2 + strength);
}

export function latitude(layer: number) {
  return -220 * layer;
}

export function territoryLabelSize(radius: number) {
  return Math.max(13, Math.min(22, radius * 0.15));
}

export function labelPriority(dependents: number, dependencies: number) {
  return dependents + dependencies;
}

export function laneWidth(strength: number, strongest: number) {
  return 0.35 + (0.25 * Math.log1p(strength)) / Math.log1p(strongest);
}

export function roadWidth(strength: number, strongest: number) {
  return 0.7 + Math.log1p(strength) / Math.log1p(strongest);
}

/** Dependency line weight in screen pixels, from module imports between two packages. */
export function dependencyPen(strength: number, strongest: number) {
  return (
    0.9 + (0.9 * Math.log1p(strength)) / Math.log1p(Math.max(1, strongest))
  );
}

/** `value` as a multiple of the package's saved high fan-in cutoff; 0 for a package without one, so it raises and widens nothing. */
function perCutoff(value: number, cutoff: number) {
  return cutoff > 0 ? value / cutoff : 0;
}

/** A module at its package's cutoff gets a footprint of 2 + 0.8 × √5; it grows with the square root of fan-in over the cutoff and stops at 6. */
const footprintAtCutoff = 5;

/** Landmark footprint for a structurally significant module, from its internal fan-in against its package's cutoff. */
export function landmarkRadius(internalFanIn: number, cutoff: number) {
  return Math.min(
    6,
    2 + 0.8 * Math.sqrt(footprintAtCutoff * perCutoff(internalFanIn, cutoff))
  );
}

/** Stream width between two districts, from their module edges. */
export function streamWidth(moduleEdges: number, strongest: number) {
  return 0.35 + (0.75 * Math.log1p(moduleEdges)) / Math.log1p(strongest);
}

/** Crowd and zoom control cartographic texture, never the unresolved count itself. */
export function marshDetail(unresolved: number, pixels: number) {
  return {
    opacity: Math.max(
      0.35,
      Math.min(1, Math.sqrt(12 / Math.max(1, unresolved)))
    ),
    spacing: Math.max(2.4, 10 / pixels),
  };
}

/** A shared river keeps a mineral body, then resolves to a fine pen line. */
export function riverPen(width: number, pixels: number) {
  return Math.min(width, (0.65 + 1.6 * width) / pixels);
}

/** Overview file dots grow gently with zoom, so dense packages stay dotted rather than blotted. */
export function speckRadius(pixels: number) {
  return 1.45 / Math.sqrt(Math.max(0.25, pixels));
}

/** File settlements remain legible as the camera enters close detail. */
export function filePen(pixels: number) {
  return Math.min(1.8, 4.5 / pixels);
}

/** Fixed chart coordinates; reveal fifths only when their spacing has room. */
export function chartGrid(pixels: number) {
  return {
    majorStep: 90,
    minorOpacity: 0.14 * Math.max(0, Math.min(1, (18 * pixels - 30) / 30)),
    minorStep: 18,
  };
}

/** Summit height of a high fan-in module, from its internal fan-in against its package's cutoff; never quality or churn. */
export function summitHeight(internalFanIn: number, cutoff: number) {
  return Math.max(0, 1.8 * Math.log2(perCutoff(1 + internalFanIn, cutoff)));
}

/** A summit's foot widens with its height, so heights stay rounded hills. */
export function summitReach(height: number) {
  return 10 + 4 * height;
}

/** Rounded summit: zero slope at the crown and at its foot. */
export function summitProfile(distanceSquared: number, height: number) {
  const reach = summitReach(height);
  const falloff = Math.max(0, 1 - distanceSquared / (reach * reach));
  return height * falloff * falloff;
}

const rangeSharpness = 8;

/** Soft maximum of neighbouring summits: clusters join into one range without stacking. */
export function rangeBlend(hills: Iterable<number>) {
  let total = 0;
  for (const hill of hills) {
    total += hill ** rangeSharpness;
  }
  return total ** (1 / rangeSharpness);
}

/**
 * Lowland rounds over the beach, then keeps rising gently inland; it never
 * levels into a table. Both terms depend only on clearance from the coast.
 */
export function lowland(clearance: number) {
  const c = Math.max(0, clearance);
  return 1.0 * (1 - Math.exp(-c / 4)) + 0.9 * (1 - Math.exp(-c / 30));
}

/** Every island stands a slight lift above the sea, an old chart's raised coast. */
export const islandPlinth = 0.45;

/** A ten-unit shoreward ramp keeps land attached to the original coastline. */
export function shoreRamp(clearance: number) {
  const t = Math.max(0, Math.min(1, clearance / 10));
  return t * t * (3 - 2 * t);
}

/** Contours between shared shelf levels; every second contour is emphasized. */
export const terrainContourLevels = [2, 4, 6, 8];
