import type { Territory } from "../data/types";
import { inkAlpha, inks } from "../ladder/ink-ladder";
import type { Stroke } from "./marks";
import { ringPoints, runPoints } from "./marks";
import { coastPenRuns, penWeights } from "./pen-runs";

/**
 * Widths in CSS pixels. The painter drew these doubled under a clip that
 * kept only the inner half; draped on the relief nothing is clipped, so
 * these are the widths that were seen: the gilt rule, the dark hairline that
 * frames it on both sides, and the pen at unit pressure.
 */
const rulePen = 2.75;
const framePen = rulePen + 0.6;
const coastPen = 1;
/** The selected island's pen presses harder. */
const selectedCoastPen = 1.3;

/** An island's coast polylines in the chart's coordinates: the rings, and the pen runs by weight. */
interface CoastLines {
  rings: number[][];
  runs: number[][][];
}

const coastLines = new WeakMap<Territory, CoastLines>();

/** Kept per island, so a rebuild hands the renderer the same polylines and it keeps their draping. */
function linesOf(territory: Territory): CoastLines {
  let lines = coastLines.get(territory);
  if (!lines) {
    lines = {
      rings: territory.coast
        .flat()
        .map((ring) => ringPoints(ring, territory.x, territory.y)),
      runs: coastPenRuns(territory).map((runs) =>
        runs.map((run) => runPoints(run, territory.x, territory.y))
      ),
    };
    coastLines.set(territory, lines);
  }
  return lines;
}

/**
 * Every island's coast ink, draped on its relief: a gilt rule framed by a
 * fine hairline, then the hand-inked coastline whose pen swells and thins
 * along the shore. Selection is shown by the ring in selection-ink.ts; here
 * it only firms the pen. Built once per set of islands and selection.
 */
export function coastMarks(
  territories: readonly Territory[],
  selected: string | null
): Stroke[] {
  const marks: Stroke[] = [];
  for (const territory of territories) {
    const { rings, runs } = linesOf(territory);
    for (const [colour, alpha, width] of [
      [inks.coastFrame, inkAlpha.coastFrame, framePen],
      [inks.coastRule, 1, rulePen],
    ] as const) {
      for (const points of rings) {
        marks.push({
          alpha,
          colour,
          kind: "stroke",
          on: territory,
          points,
          width,
        });
      }
    }
    const base = territory.id === selected ? selectedCoastPen : coastPen;
    for (const [weight, weighted] of runs.entries()) {
      const width = base * (penWeights[weight] ?? 1);
      for (const points of weighted) {
        marks.push({
          alpha: inkAlpha.coastPen,
          cap: "round",
          colour: inks.coastPen,
          kind: "stroke",
          on: territory,
          points,
          width,
        });
      }
    }
  }
  return marks;
}
