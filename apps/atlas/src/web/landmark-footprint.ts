import { unit } from "./geography";
import type { FeaturePoint } from "./natural-features";
import type { AtlasFile } from "./types";

/** A landmark footprint fits between existing settlements; their positions never move. */
export function landmarkFootprint(
  file: AtlasFile,
  radius: number,
  files: readonly AtlasFile[]
): FeaturePoint[] {
  const count = 64;
  const phase = unit(file.id) * Math.PI * 2;
  const neighbours = files.filter(
    (other) =>
      other.id !== file.id &&
      Math.hypot(other.x - file.x, other.y - file.y) < radius * 3
  );
  const radii = Array.from({ length: count }, (_, i) => {
    const angle = (i * Math.PI * 2) / count;
    const dx = Math.cos(angle),
      dy = Math.sin(angle);
    let reach =
      radius *
      (0.88 +
        0.08 * Math.sin(3 * angle + phase) +
        0.04 * Math.sin(5 * angle - phase));
    for (const other of neighbours) {
      const x = other.x - file.x,
        y = other.y - file.y;
      const projection = x * dx + y * dy;
      if (projection > 0) {
        const limit = Math.max(0.001, ((x * x + y * y) * 0.42) / projection);
        reach = (reach ** -6 + limit ** -6) ** (-1 / 6);
      }
    }
    return reach;
  });
  // Only shrink while rounding, preserving the clearance established above.
  return radii.map((reach, i) => {
    const before = radii[(i + count - 1) % count] ?? reach;
    const after = radii[(i + 1) % count] ?? reach;
    const fitted = Math.min(reach, (before + reach * 2 + after) / 4);
    const angle = (i * Math.PI * 2) / count;
    return {
      x: file.x + Math.cos(angle) * fitted,
      y: file.y + Math.sin(angle) * fitted,
    };
  });
}
