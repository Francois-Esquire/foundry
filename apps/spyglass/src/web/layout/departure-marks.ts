import { placementKey } from "../data/resolve";
import type { SpyglassData, Territory } from "../data/types";
import { departureRing, inkStyle } from "../ladder/ink-ladder";
import { departures } from "./departures";
import { nearestCoast, seaCurve, seaCurvePoints } from "./dependency-links";
import type { DomainExtent } from "./domain-extent";
import type { Glyph, Mark } from "./marks";
import { dashOf } from "./marks";

/** Where a line meets its target, held back from the coast as selection lines are, in map units. */
const targetClearance = 7;
/** The bead at a line's target end, in screen pixels, as on the selection's lines. */
const beadRadius = 2.2;

interface DepartureCurve {
  end: readonly [number, number];
  points: number[];
}

const curves = new WeakMap<SpyglassData, DepartureCurve[]>();

/** Each ranked line's curve from its marks to the nearest coast of the package it departs toward; once per spyglass. */
function departureCurves(data: SpyglassData): DepartureCurve[] {
  const cached = curves.get(data);
  if (cached) {
    return cached;
  }
  const territories = new Map(data.territories.map((t) => [t.id, t]));
  const result = departures(data).lines.flatMap((line): DepartureCurve[] => {
    const target = territories.get(line.toward);
    if (!target) {
      return [];
    }
    const from: [number, number] = [line.from.x, line.from.y];
    const curve = seaCurve(from, nearestCoast(from, target), {
      end: targetClearance,
      start: 0,
    });
    return [{ end: curve.end, points: seaCurvePoints(curve) }];
  });
  curves.set(data, result);
  return result;
}

/** A ring's glyph at a departure mark: upright, so it reads round on screen, draped on the island it marks. */
function ringAt(
  mark: { level: keyof typeof departureRing.radius; x: number; y: number },
  territory: Territory | undefined
): Pick<Glyph, "kind" | "on" | "size" | "upright" | "x" | "y"> {
  return {
    kind: "glyph",
    on: territory,
    size: 2 * departureRing.radius[mark.level],
    upright: true,
    x: mark.x,
    y: mark.y,
  };
}

/**
 * Departures, from the `placement` lens: a notched ring on each departing
 * file, folder, or single-consumer package, round on screen and draped on
 * its island, and a dash-dot line from each ranked group to the nearest
 * coast of the package it departs toward, ended by a bead there, flat on
 * the sea as selection lines are, so an island it passes behind hides it.
 * Drawn by default. While anything is selected the selection's lines win
 * and no departure line is drawn; the rings stay, being on land. Built
 * once per spyglass and selection.
 */
export function departureMarks(
  data: SpyglassData,
  selected: string | null
): Mark[] {
  const { marks } = departures(data);
  if (!marks.length) {
    return [];
  }
  const territories = new Map(data.territories.map((t) => [t.id, t]));
  const ring = inkStyle("departure");
  const result: Mark[] = marks.map((mark) => ({
    ...ringAt(mark, territories.get(mark.package)),
    alpha: 1,
    colour: ring.hue,
    shape: "notchedRing",
    weight: ring.weight,
  }));
  if (selected) {
    return result;
  }
  const pen = inkStyle("departure-line");
  const bead = inkStyle("departure-bead");
  for (const curve of departureCurves(data)) {
    result.push({
      alpha: 1,
      colour: pen.hue,
      dash: dashOf(pen),
      kind: "stroke",
      points: curve.points,
      width: pen.weight,
    });
    // A bead at the target's end gives the line its direction.
    result.push({
      alpha: 1,
      colour: bead.hue,
      kind: "glyph",
      shape: "dot",
      size: 2 * beadRadius,
      x: curve.end[0],
      y: curve.end[1],
    });
  }
  return result;
}

/**
 * The departures a chosen domain explains, their domain label
 * `shares-domain` with it among the shared: the notch of each ring is
 * closed by a plug in the domain's ink, heavier than the ring, so the ring
 * still reads as a departure and the plug as the domain's. The plug is the
 * ring's own glyph size and stance, so it meets the ring at any zoom. A
 * domain departure takes nothing more.
 */
export function domainDepartureMarks(
  data: SpyglassData,
  domain: DomainExtent | null
): Glyph[] {
  if (!domain?.explained.size) {
    return [];
  }
  const territories = new Map(data.territories.map((t) => [t.id, t]));
  const pen = inkStyle("domain-explained");
  const plugs: Glyph[] = [];
  for (const mark of departures(data).marks) {
    if (
      mark.frame !== domain.frame ||
      !domain.explained.has(placementKey(mark))
    ) {
      continue;
    }
    plugs.push({
      ...ringAt(mark, territories.get(mark.package)),
      alpha: 1,
      colour: pen.hue,
      shape: "notchPlug",
      weight: pen.weight,
    });
  }
  return plugs;
}
