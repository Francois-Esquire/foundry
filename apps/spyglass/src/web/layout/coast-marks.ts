import type { Territory } from "../data/types";
import { inkAlpha } from "../ladder/ink-ladder";
import { inkStyle } from "../ladder/ink-table";
import type { Stroke } from "./marks";
import { inkedStroke, placePolylines } from "./marks";
import { coastPenRuns, coastPolylines, penWeights } from "./pen-runs";

/**
 * The ladder's rows for the coast, whose weights are the widths seen on
 * screen: the gilt rule, the dark hairline that frames it on both sides, and
 * the pen at unit pressure.
 */
const rule = inkStyle("coast-rule");
const frame = inkStyle("coast-frame");
const pen = inkStyle("coast");
/** The selected island's pen presses harder. */
const selectedPenPressure = 1.3;

/**
 * Every island's coast ink, draped on its relief: a gilt rule framed by a
 * fine hairline, then the hand-inked coastline whose pen swells and thins
 * along the shore. Selection is shown by the ring in selection-ink.ts; here
 * it only firms the pen. Built once per set of islands and selection; the
 * polylines are kept per island (`coastPolylines`, `placePolylines`), so a
 * rebuild hands the renderer the same ones and it keeps their draping.
 */
export function coastMarks(
  territories: readonly Territory[],
  selected: string | null
): Stroke[] {
  const marks: Stroke[] = [];
  for (const territory of territories) {
    const rings = coastPolylines(territory);
    for (const [style, alpha] of [
      [frame, inkAlpha.coastFrame],
      [rule, 1],
    ] as const) {
      for (const points of rings) {
        marks.push(inkedStroke(style, points, { alpha, on: territory }));
      }
    }
    const base =
      pen.weight * (territory.id === selected ? selectedPenPressure : 1);
    for (const [weight, runs] of coastPenRuns(territory).entries()) {
      const width = base * (penWeights[weight] ?? 1);
      for (const points of placePolylines(runs, territory.x, territory.y)) {
        marks.push(
          inkedStroke(pen, points, {
            alpha: inkAlpha.coastPen,
            cap: "round",
            on: territory,
            width,
          })
        );
      }
    }
  }
  return marks;
}
