import { compositionFrame, compositionReveal } from "../composition-motion";
import { compositionInsideLand } from "../composition-placement";
import type { ResponsibilityOverlay } from "../responsibility-focus";
import type { Territory } from "../types";

export function hitComposition(
  territory: Territory,
  overlay: ResponsibilityOverlay,
  x: number,
  y: number,
  pixels: number
) {
  const { composition } = overlay;
  const file = territory.files.find((item) => item.id === composition?.fileId);
  const { detail } = compositionReveal(pixels);
  if (
    !(
      composition &&
      file &&
      detail &&
      compositionInsideLand(x, y, territory.coast)
    )
  ) {
    return null;
  }
  let nearest: string | undefined,
    distance = Math.max(0.8, 4 / pixels);
  for (const mark of compositionFrame(overlay, pixels)) {
    const positions = [{ x: mark.x, y: mark.y }];
    if (mark.ghost) {
      positions.push(mark.ghost);
    }
    for (const point of positions) {
      const next = Math.hypot(x - file.x - point.x, y - file.y - point.y);
      if (next < distance) {
        nearest = mark.id;
        distance = next;
      }
    }
  }
  return nearest
    ? {
        file,
        symbol: { id: nearest, name: composition.names[nearest] ?? nearest },
      }
    : null;
}
