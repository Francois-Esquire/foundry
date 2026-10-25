import type { SpyglassData } from "../data/types";
import { inkStyle } from "../ladder/ink-table";
import { type CrossingPair, crossingPairs } from "./crossings";
import { nearestCoasts, seaCurve, seaCurvePoints } from "./dependency-links";
import type { Mark } from "./marks";
import { inkedStroke } from "./marks";

/** Clearance between a crossing's ends and each coast, in map units, as a selection line keeps. */
const coastClearance = 7;
/** The bead at the package depended on, in screen pixels: a shade larger than a departure's, for the heavier line. */
const crossingBead = 2.6;

interface CrossingLine {
  end: readonly [number, number];
  pair: CrossingPair;
  points: number[];
}

const drawn = new WeakMap<SpyglassData, CrossingLine[]>();

/**
 * Each pair of packages a crossing joins, as one curve between their nearest
 * coasts, bowed as selection lines are; worked out once per spyglass.
 */
function crossingLines(data: SpyglassData): CrossingLine[] {
  const cached = drawn.get(data);
  if (cached) {
    return cached;
  }
  const territories = new Map(data.territories.map((t) => [t.id, t]));
  const lines = crossingPairs(data).flatMap((pair): CrossingLine[] => {
    const from = territories.get(pair.from);
    const to = territories.get(pair.to);
    if (!(from && to)) {
      return [];
    }
    const [a, b] = nearestCoasts(from, to);
    const curve = seaCurve(a, b, {
      end: coastClearance,
      start: coastClearance,
    });
    return [{ end: curve.end, pair, points: seaCurvePoints(curve) }];
  });
  drawn.set(data, lines);
  return lines;
}

/**
 * Crossings, a collection's declared dependencies between workspaces: one
 * line of long dashes for each pair of packages, from the package that
 * declares the dependency to a bead at the one it names, flat on the sea
 * between the frames, so the islands it passes behind hide it by depth.
 * Not routes, and never selected. Selection wins: while an island is
 * selected, only its own crossings stay drawn, under its lines; the others
 * go. Built once per spyglass and selection.
 */
export function crossingMarks(
  data: SpyglassData,
  selected: string | null
): Mark[] {
  if (!data.crossings?.length) {
    return [];
  }
  const lines = crossingLines(data).filter(
    ({ pair }) => !selected || pair.from === selected || pair.to === selected
  );
  const pen = inkStyle("crossing");
  const bead = inkStyle("crossing-bead");
  const marks: Mark[] = [];
  for (const line of lines) {
    marks.push(inkedStroke(pen, line.points));
    marks.push({
      alpha: 1,
      colour: bead.hue,
      kind: "glyph",
      shape: "dot",
      size: 2 * crossingBead,
      x: line.end[0],
      y: line.end[1],
    });
  }
  return marks;
}
