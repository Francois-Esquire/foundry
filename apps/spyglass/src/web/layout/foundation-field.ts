import type { SpyglassFoundation } from "../data/types";

/** The overview stays legible; every shared dependency remains individually inspectable. */
export const foundationOverviewLimit = 12;

export function visibleFoundations(
  foundations: readonly SpyglassFoundation[],
  focus = ""
): SpyglassFoundation[] {
  if (focus) {
    return foundations.filter(({ id }) => id === focus);
  }
  const strength = (foundation: SpyglassFoundation) =>
    foundation.members.reduce((total, member) => total + member.weight, 0);
  return [...foundations]
    .sort((a, b) => strength(b) - strength(a) || a.id.localeCompare(b.id))
    .slice(0, foundationOverviewLimit);
}

/** Fixed world-space bathymetry; animation and visibility never enter this calculation. */
export function foundationField(
  foundations: readonly SpyglassFoundation[],
  extent: { width: number; height: number },
  focus = "",
  resolution = 384
) {
  const scale = resolution / Math.max(extent.width, extent.height, 1);
  const width = Math.max(2, Math.ceil(extent.width * scale));
  const height = Math.max(2, Math.ceil(extent.height * scale));
  const values = new Float32Array(width * height);
  const selected = visibleFoundations(foundations, focus);
  const deposit = (x: number, y: number, radius: number, strength: number) => {
    const reach = radius * 1.4;
    const left = Math.max(
      0,
      Math.floor((x - reach + extent.width / 2) * scale)
    );
    const right = Math.min(
      width - 1,
      Math.ceil((x + reach + extent.width / 2) * scale)
    );
    const top = Math.max(
      0,
      Math.floor((y - reach + extent.height / 2) * scale)
    );
    const bottom = Math.min(
      height - 1,
      Math.ceil((y + reach + extent.height / 2) * scale)
    );
    for (let row = top; row <= bottom; row += 1) {
      for (let column = left; column <= right; column += 1) {
        const px = ((column + 0.5) / width) * extent.width - extent.width / 2;
        const py = ((row + 0.5) / height) * extent.height - extent.height / 2;
        const bend = 0.07 * Math.sin(px * 0.023) * Math.sin(py * 0.031);
        const distance =
          Math.hypot((px - x) / radius, (py - y) / radius) + bend;
        const t = Math.max(0, Math.min(1, 1 - distance / 1.3));
        const level = t * t * (3 - 2 * t) * strength;
        const index = row * width + column;
        // Overlap raises the shelf softly, without hundreds of paths becoming white.
        values[index] = 1 - (1 - (values[index] ?? 0)) * (1 - level);
      }
    }
  };
  for (const foundation of selected) {
    for (const lobe of foundation.lobes) {
      deposit(lobe.x, lobe.y, lobe.radius, 0.75 * Math.sqrt(lobe.weight));
      // A low saddle connects each consumer's shelf toward the shared centre.
      const distance = Math.hypot(lobe.x - foundation.x, lobe.y - foundation.y);
      const steps = Math.min(
        24,
        Math.ceil(distance / Math.max(lobe.radius * 0.6, 1))
      );
      for (let step = 1; step <= steps; step += 1) {
        const t = step / Math.max(1, steps);
        deposit(
          lobe.x + (foundation.x - lobe.x) * t,
          lobe.y + (foundation.y - lobe.y) * t,
          lobe.radius * 0.6,
          0.18 * Math.sqrt(lobe.weight)
        );
      }
    }
  }
  return { height, values, width };
}
