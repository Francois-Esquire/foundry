import type { Territory } from "../types";

/** A point on the page, in CSS pixels, as pointer events give it. */
export interface PagePoint {
  clientX: number;
  clientY: number;
}

/**
 * Where the pointer rests over the map. The island under it is asked for
 * again at every repaint, through the repaint's own hit test, so a camera
 * that moves under a still pointer (a wheel zoom, Escape, a header button's
 * zoom) inks the island now under it, not the one it was over.
 */
export function createHoverTarget() {
  let pointer: PagePoint | null = null;
  return {
    /** The id of the island under the resting pointer, for this repaint's camera and layout. */
    island(islandAt: (point: PagePoint) => string | undefined): string | null {
      return pointer ? (islandAt(pointer) ?? null) : null;
    },
    leave() {
      pointer = null;
    },
    move(point: PagePoint) {
      pointer = { clientX: point.clientX, clientY: point.clientY };
    },
  };
}

/**
 * The island to ink for a hovered id, looked up in the territories being
 * drawn, so a relayout inks the island where it is now; none for the
 * selected island, which keeps its gilt ring.
 */
export function hoveredIsland(
  id: string | null,
  territories: readonly Territory[],
  selected: string | null
): Territory | null {
  if (!id || id === selected) {
    return null;
  }
  return territories.find((territory) => territory.id === id) ?? null;
}
