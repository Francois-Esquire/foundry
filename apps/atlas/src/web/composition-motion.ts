import { clearOfCoast, compositionInsideLand } from "./composition-placement";
import { detailLevel } from "./detail-level";
import type { ResponsibilityOverlay } from "./responsibility-focus";
import type { Polygon } from "./types";

export function compositionMotionFits(
  points: readonly { x: number; y: number }[],
  coast: Polygon[]
) {
  if (!points.length) {
    return false;
  }
  const x = points.reduce((sum, point) => sum + point.x, 0) / points.length;
  const y = points.reduce((sum, point) => sum + point.y, 0) / points.length;
  const radius =
    Math.max(...points.map((point) => Math.hypot(point.x - x, point.y - y))) +
    0.8;
  return (
    compositionInsideLand(x, y, coast) && clearOfCoast(x, y, coast, radius)
  );
}

export function compositionReveal(pixels: number) {
  const detail = detailLevel(pixels, true).composition;
  return { detail, spread: 1 - (1 - detail) ** 3 };
}

export function compositionFrame(
  overlay: ResponsibilityOverlay,
  pixels: number
) {
  const { spread } = compositionReveal(pixels);
  const stationary = new Set(overlay.composition?.stationary);
  const stationaryTrace = new Set(overlay.trace?.stationary);
  const targets = new Map(overlay.trace?.marks.map((mark) => [mark.id, mark]));
  return (overlay.composition?.marks ?? []).map((mark) => {
    const scale =
      overlay.reducedMotion === true || stationary.has(mark.id) ? 1 : spread;
    const x = mark.x * scale,
      y = mark.y * scale;
    const target = targets.get(mark.id);
    const progress = overlay.trace?.progress ?? 0;
    const fade = overlay.reducedMotion === true || stationaryTrace.has(mark.id);
    return {
      ghost:
        target && progress > 0
          ? {
              alpha: fade ? progress : 1,
              tether: !fade,
              x: fade ? target.x : x + (target.x * spread - x) * progress,
              y: fade ? target.y : y + (target.y * spread - y) * progress,
            }
          : undefined,
      id: mark.id,
      x,
      y,
    };
  });
}
