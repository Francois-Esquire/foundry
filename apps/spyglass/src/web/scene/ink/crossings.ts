import { type CrossingPair, crossingPairs } from "../../crossings";
import type { SpyglassData } from "../../types";
import { dashAt, inkStyle } from "../ink-ladder";
import {
  clipToSea,
  nearestCoasts,
  type SeaCurve,
  seaCurve,
} from "../selection-ink";
import type { InkState } from "./state";

/** Clearance between a crossing's ends and each coast, in map units, as a selection line keeps. */
const coastClearance = 7;
/** The bead at the package depended on, in screen pixels: a shade larger than a departure's, for the heavier line. */
const crossingBead = 2.6;

interface CrossingLine extends SeaCurve {
  pair: CrossingPair;
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
  const lines = crossingPairs(data).flatMap((pair) => {
    const from = territories.get(pair.from);
    const to = territories.get(pair.to);
    if (!(from && to)) {
      return [];
    }
    const [a, b] = nearestCoasts(from, to);
    return [
      {
        ...seaCurve(a, b, { end: coastClearance, start: coastClearance }),
        pair,
      },
    ];
  });
  drawn.set(data, lines);
  return lines;
}

/**
 * Crossings, a collection's declared dependencies between workspaces: one
 * line of long dashes for each pair of packages, from the package that
 * declares the dependency to a bead at the one it names, over the sea
 * between the frames, routed and cut as departure lines are. Not routes, and
 * never selected. Selection wins: while an island is selected, only its own
 * crossings stay drawn, under its lines; the others go.
 */
export function paintCrossings(state: InkState): void {
  const { ctx, data, labels, pixels, selected } = state;
  if (!data.crossings?.length) {
    return;
  }
  const lines = crossingLines(data).filter(
    ({ pair }) => !selected || pair.from === selected || pair.to === selected
  );
  if (!lines.length) {
    return;
  }
  const pen = inkStyle("crossing");
  ctx.save();
  clipToSea(ctx, data, labels, pixels);
  ctx.strokeStyle = pen.hue;
  ctx.fillStyle = inkStyle("crossing-bead").hue;
  ctx.lineWidth = pen.weight / pixels;
  for (const line of lines) {
    ctx.setLineDash(dashAt(pen, pixels));
    ctx.beginPath();
    ctx.moveTo(...line.start);
    ctx.quadraticCurveTo(...line.control, ...line.end);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.beginPath();
    ctx.arc(...line.end, crossingBead / pixels, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();
}
