import type { Territory } from "../data/types";
import { inkAlpha, inkStyle, inks } from "../ladder/ink-ladder";
import type { Stroke } from "./marks";
import { ringPoints } from "./marks";

/** The soft band beneath the hover's line, in CSS pixels. */
const bandWidth = 6;

const coastLines = new WeakMap<Territory, number[][]>();

/** An island's coast rings in the chart's coordinates, kept per island so a hover keeps its draping. */
function coastOf(territory: Territory): number[][] {
  let lines = coastLines.get(territory);
  if (!lines) {
    lines = territory.coast
      .flat()
      .map((ring) => ringPoints(ring, territory.x, territory.y));
    coastLines.set(territory, lines);
  }
  return lines;
}

/**
 * The coast of the island under the pointer, draped on its relief: a soft
 * band beneath a fine solid line, in the ladder's hover amber, at constant
 * screen widths. Static: it appears and goes with the hover, nothing fades.
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
    for (const points of coastOf(territory)) {
      marks.push({
        alpha,
        colour: inks.hover,
        kind: "stroke",
        on: territory,
        points,
        width,
      });
    }
  }
  return marks;
}
