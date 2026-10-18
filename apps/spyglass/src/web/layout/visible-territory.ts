import type { Territory } from "../data/types";
import type { InkView } from "../view/chart-view";

/** The island whose regions the view frames: the nearest one near the view's centre, once zoomed in enough to read them. */
export function visibleRegionTerritory(
  territories: Territory[],
  view: InkView
): Territory | undefined {
  if (view.pixelsPerUnit < 1.2) {
    return undefined;
  }
  let nearest: Territory | undefined;
  let distance = Number.POSITIVE_INFINITY;
  for (const territory of territories) {
    const next = Math.hypot(territory.x - view.x, territory.y - view.y);
    if (next < territory.radius * 1.5 && next < distance) {
      nearest = territory;
      distance = next;
    }
  }
  return nearest;
}
