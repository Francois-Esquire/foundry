import type { RenderDensity } from "../context";
import { LISTED_AT_DENSITY } from "../context";
import type { BlockView, RankedItem, SectionView } from "../views";

/** A titled ranked list of the first items at the density, counting the rest; none when there is nothing to list. */
export function rankedSection(
  items: RankedItem[],
  density: RenderDensity,
  title: string
): SectionView | undefined {
  const shown = items.slice(0, LISTED_AT_DENSITY[density]);
  if (shown.length === 0) {
    return;
  }
  const list: BlockView = {
    items: shown,
    kind: "rankedList",
    ...(items.length > shown.length && {
      overflow: items.length - shown.length,
    }),
  };
  return { blocks: [list], title };
}
