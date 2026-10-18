import { chartGrid } from "../data/bindings";
import { inkAlpha, inks } from "../ladder/ink-ladder";
import type { Stroke } from "./marks";

/** One graticule ink on sea and land, so the grid reads as a single printing. */
const gridInk = inks.grid;

/**
 * The chart's grid over the whole sea the camera may reach: fixed
 * coordinates, so the lines never move with the view, and only the minor
 * divisions' alpha changes with zoom. Built once; the sea extent is the only
 * input.
 */
export function chartGridMarks(sea: {
  height: number;
  width: number;
}): Stroke[] {
  const { majorStep, minorStep } = chartGrid(1);
  const left = -sea.width / 2;
  const top = -sea.height / 2;
  const right = sea.width / 2;
  const bottom = sea.height / 2;
  const marks: Stroke[] = [];
  const rule = (points: number[], width: number, alpha: Stroke["alpha"]) => {
    marks.push({ alpha, colour: gridInk, kind: "stroke", points, width });
  };
  for (const { step, alpha, width } of [
    { alpha: inkAlpha.gridMinor, step: minorStep, width: 0.5 },
    { alpha: inkAlpha.gridMajor, step: majorStep, width: 0.7 },
  ]) {
    for (let x = Math.ceil(left / step) * step; x <= right; x += step) {
      rule([x, top, x, bottom], width, alpha);
    }
    for (let y = Math.ceil(top / step) * step; y <= bottom; y += step) {
      rule([left, y, right, y], width, alpha);
    }
  }
  return marks;
}
