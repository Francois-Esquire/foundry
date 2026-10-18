import type { SpyglassData, Territory } from "../data/types";
import { closeMark, enteredAt, inkStyle } from "../ladder/ink-ladder";
import { clipPolyline } from "./clip";
import type { Glyph, Mark, MarkAlpha, Stroke } from "./marks";
import { dashOf, placePolygons } from "./marks";
import { insidePolygons } from "./polygons";
import { drawnTies, proximities } from "./proximity";

/** A tie's bead, in screen pixels. */
const beadRadius = 1.8;

/** Proximity shows at island zoom only, so the overview stays the departures'. */
const atIslandZoom: MarkAlpha = (pixels) => (pixels >= enteredAt ? 1 : 0);

/** What the ties and marks are worked out from. */
type ProximityData = Pick<SpyglassData, "frames" | "territories">;

/** An island's ties, each cut to the land and ending in a bead where the bead lies on land. */
function tieMarks(
  data: ProximityData,
  territory: Territory,
  fileId: string | null
): Mark[] {
  const coast = placePolygons(territory.coast, territory.x, territory.y);
  const bead = inkStyle("proximity-bead");
  const marks: Mark[] = [];
  const beads: Glyph[] = [];
  for (const tie of drawnTies(data, territory.id, fileId)) {
    const pen = inkStyle(
      tie.kind === "apart" ? "proximity-apart" : "proximity-co-change"
    );
    for (const piece of clipPolyline(
      [tie.from.x, tie.from.y, tie.to.x, tie.to.y],
      coast
    )) {
      marks.push({
        alpha: atIslandZoom,
        cap: "round",
        colour: pen.hue,
        dash: dashOf(pen),
        kind: "stroke",
        on: territory,
        points: piece,
        width: pen.weight,
      } satisfies Stroke);
    }
    const ends = tie.kind === "apart" ? [tie.to] : [tie.from, tie.to];
    for (const end of ends) {
      if (!insidePolygons(end, coast)) {
        continue;
      }
      beads.push({
        alpha: atIslandZoom,
        colour: bead.hue,
        kind: "glyph",
        on: territory,
        shape: "dot",
        size: 2 * beadRadius,
        x: end.x,
        y: end.y,
      });
    }
  }
  return [...marks, ...beads];
}

/** "( )" on each folder whose files serve unrelated responsibilities, round on screen, where it lies on land. */
function closeMarks(data: ProximityData): Glyph[] {
  const sides = inkStyle("proximity-close");
  const islands = new Map(data.territories.map((item) => [item.id, item]));
  const marks: Glyph[] = [];
  for (const mark of proximities(data).marks) {
    const territory = islands.get(mark.package);
    const onLand =
      territory &&
      insidePolygons(
        { x: mark.x - territory.x, y: mark.y - territory.y },
        territory.coast
      );
    if (!onLand) {
      continue;
    }
    marks.push({
      alpha: atIslandZoom,
      colour: sides.hue,
      kind: "glyph",
      on: territory,
      shape: "closeMark",
      size: 2 * closeMark.radius,
      upright: true,
      weight: sides.weight,
      x: mark.x,
      y: mark.y,
    });
  }
  return marks;
}

/**
 * Proximity, from island zoom: ties for what is related but apart (a dotted
 * tie from a file to its responsibility's folder, a dashed one between two
 * files that change together), at most a few on each island, or all of a
 * selected file's, cut to the land as the painter clipped them, with a bead
 * at each end on land; and the "( )" mark on each folder whose files serve
 * unrelated responsibilities. Every mark is draped on its island and shows
 * through one alpha from island zoom, so the layer is built once per chart
 * and selected file.
 */
export function proximityMarks(
  data: ProximityData,
  fileId: string | null
): Mark[] {
  const marks: Mark[] = [];
  for (const territory of data.territories) {
    marks.push(...tieMarks(data, territory, fileId));
  }
  marks.push(...closeMarks(data));
  return marks;
}
