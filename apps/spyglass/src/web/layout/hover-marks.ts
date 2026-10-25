import type { Territory } from "../data/types";
import { inkAlpha } from "../ladder/ink-ladder";
import { inkStyle } from "../ladder/ink-table";
import type { Stroke } from "./marks";
import { inkedStroke } from "./marks";
import { coastPolylines } from "./pen-runs";

/** The soft band beneath the hover's line, in CSS pixels. */
const bandWidth = 6;

/**
 * The coast of the island under the pointer, draped on its relief: a soft
 * band beneath a fine solid line, in the ladder's hover amber, at constant
 * screen widths. Static: it appears and goes with the hover, nothing fades.
 * The polylines are the coast layer's own (`coastPolylines`), so the hover
 * shares their draping.
 */
export function hoverMarks(territory: Territory | null): Stroke[] {
  if (!territory) {
    return [];
  }
  const line = inkStyle("hover");
  const marks: Stroke[] = [];
  for (const [alpha, width] of [
    [inkAlpha.hoverBand, bandWidth],
    [inkAlpha.hoverLine, line.weight],
  ] as const) {
    for (const points of coastPolylines(territory)) {
      marks.push(inkedStroke(line, points, { alpha, on: territory, width }));
    }
  }
  return marks;
}
