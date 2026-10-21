import { dependencyPen } from "../data/bindings";
import type { SpyglassData } from "../data/types";
import { enteredAt, inks } from "../ladder/ink-ladder";
import { inkStyle } from "../ladder/ink-table";
import { dependencyLinks, seaCurvePoints } from "./dependency-links";
import type { Mark, MarkAlpha } from "./marks";
import { inkedStroke, ringPoints } from "./marks";
import { selectionRing } from "./selection-ring";

/** The bead at the other package's end of each line, in screen pixels. */
const beadRadius = 2.2;
/** Line widths are rounded to this, so near-equal pens share a line object. */
const penStep = 0.05;

/** The ring at overview: once the island is entered the breadcrumb carries the selection. */
const beforeEntering: MarkAlpha = (pixels) => (pixels < enteredAt ? 1 : 0);
/** The ring once entered, stepped down to the file rung so it does not read as another coast. */
const onceEntered: MarkAlpha = (pixels) => (pixels < enteredAt ? 0 : 1);

const ringLines = new WeakMap<ReturnType<typeof selectionRing>, number[][]>();

/** The ring's contours as polylines, kept by the ring so a reselection keeps their vertices. */
function ringPolylines(rings: ReturnType<typeof selectionRing>): number[][] {
  let lines = ringLines.get(rings);
  if (!lines) {
    lines = rings.map((ring) => ringPoints(ring));
    ringLines.set(rings, lines);
  }
  return lines;
}

/**
 * Selection ink, the ladder's strongest: a ring around the selected island,
 * just offshore, and curves to the packages it imports from (dashed) and
 * that import it (dotted), each ending in a bead, all flat on the sea so an
 * island a line passes behind hides it by depth. The ring is laid twice, in
 * the overview's ink and in the entered one, each shown by its alpha at its
 * zoom, so a zoom never rebuilds the layer. Built once per spyglass and
 * selection; nothing without one.
 */
export function selectionMarks(
  data: SpyglassData,
  selected: string | null
): Mark[] {
  const territory = data.territories.find((t) => t.id === selected);
  if (!(territory && selected)) {
    return [];
  }
  const routes = dependencyLinks(data, selected);
  const strongest = Math.max(1, ...routes.map((link) => link.route.weight));
  const imports = inkStyle("selection-imports");
  const importers = inkStyle("selection-importers");
  const marks: Mark[] = [];
  for (const link of routes) {
    const width =
      Math.round(dependencyPen(link.route.weight, strongest) / penStep) *
      penStep;
    marks.push(
      inkedStroke(link.outgoing ? imports : importers, seaCurvePoints(link), {
        width,
      })
    );
    marks.push({
      alpha: 1,
      colour: inks.selection,
      kind: "glyph",
      shape: "dot",
      size: 2 * beadRadius,
      x: link.end[0],
      y: link.end[1],
    });
  }
  const overview = inkStyle("selection");
  const entered = inkStyle("entered-ring");
  for (const points of ringPolylines(selectionRing(territory))) {
    for (const [alpha, style] of [
      [beforeEntering, overview],
      [onceEntered, entered],
    ] as const) {
      marks.push(inkedStroke(style, points, { alpha }));
    }
  }
  return marks;
}
