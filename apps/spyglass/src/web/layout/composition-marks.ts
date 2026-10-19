import type { Polygon, Territory } from "../data/types";
import { inkAlpha, inks } from "../ladder/ink-ladder";
import { inkStyle } from "../ladder/ink-table";
import { clipPolygons, clipPolyline } from "./clip";
import type { CompositionMark } from "./composition-layout";
import { compositionFrame, compositionReveal } from "./composition-motion";
import { clearOfCoast, compositionInsideLand } from "./composition-placement";
import type { Fill, Mark, MarkAlpha, Stroke, StrokeDash } from "./marks";
import { dashOf, internAlpha, placePolygons, placePolylines } from "./marks";
import { insidePolygons } from "./polygons";
import type { ResponsibilityOverlay } from "./responsibility-focus";

/** The composition's squares, in map units: the paper under a declaration, its outline, and a ghost's. */
const compositionSquare = { ghost: 1.2, outline: 1, paper: 1.6 } as const;
/** The composition's pen, in CSS pixels. */
const compositionPen = 1;
/** A blocker's diagonal reaches this far from its centre, in map units. */
const blockerReach = 0.5;

/** The composition's reveal with the zoom: shared, so the renderer batches by it. */
const compositionDetail: MarkAlpha = (pixels) =>
  compositionReveal(pixels).detail;

/**
 * A line of the drawing in island units: its points, and the same points
 * alone in a set, which is what an uncut line hands `placePolylines`, so a
 * line kept by identity keeps its draping.
 */
interface DrawnLine {
  pieces: number[][];
  points: number[];
}

/** A square about a point, in island units: its ring as a polygon set for the fill and clip, and its outline as a line. */
interface Square extends DrawnLine {
  polygon: Polygon[];
  x: number;
  y: number;
}

function lineOf(points: number[]): DrawnLine {
  return { pieces: [points], points };
}

function squareAt(x: number, y: number, side: number): Square {
  const half = side / 2;
  const ring: Polygon[number] = [
    [x - half, y - half],
    [x + half, y - half],
    [x + half, y + half],
    [x - half, y + half],
    [x - half, y - half],
  ];
  return { ...lineOf(ring.flat()), polygon: [[ring]], x, y };
}

const squaresAtRest = new WeakMap<CompositionMark, Map<number, Square>>();

/**
 * A square about a mark at rest, kept by the mark and the side while the
 * centre stays where it was, so a rebuild for the zoom hands `clipPolygons`
 * and the drape the same geometry and both keep their results. A square at
 * a new centre, as after a relayout moves the file, replaces the kept one.
 */
function keptSquare(
  mark: CompositionMark,
  x: number,
  y: number,
  side: number
): Square {
  let bySide = squaresAtRest.get(mark);
  if (!bySide) {
    bySide = new Map();
    squaresAtRest.set(mark, bySide);
  }
  let square = bySide.get(side);
  if (!(square && square.x === x && square.y === y)) {
    square = squareAt(x, y, side);
    bySide.set(side, square);
  }
  return square;
}

/**
 * The composition's marks on one island: what the clip to its coast would
 * have hidden is cut away here, and what lies wholly on land is placed by
 * identity. Each operation composites above the previous one; pieces of a
 * clipped operation share its order so they still batch together.
 */
class CompositionDrawing {
  readonly marks: Mark[] = [];
  private readonly share = internAlpha<number>();
  private readonly territory: Territory;

  constructor(territory: Territory) {
    this.territory = territory;
  }

  /** The reveal's detail scaled by a ghost's strength, one function per strength, so ghosts alike share a batch. */
  alpha(scale: number): MarkAlpha {
    if (scale === 1) {
      return compositionDetail;
    }
    return this.share(
      scale,
      () => (pixels) => compositionReveal(pixels).detail * scale
    );
  }

  /**
   * Whether a square about a point lies wholly on land, so nothing of it is
   * cut: its centre is on land and the coast is farther than its corners.
   * Two walks of the coast, where testing each corner would be four.
   */
  clear(x: number, y: number, side: number): boolean {
    const { coast } = this.territory;
    return (
      compositionInsideLand(x, y, coast) &&
      clearOfCoast(x, y, coast, (side / 2) * Math.SQRT2)
    );
  }

  /** Whether every point of a line lies on land, for a mark not known to be clear. */
  private inland(points: readonly number[]): boolean {
    for (let i = 0; i + 1 < points.length; i += 2) {
      const at = { x: points[i] ?? 0, y: points[i + 1] ?? 0 };
      if (!insidePolygons(at, this.territory.coast)) {
        return false;
      }
    }
    return true;
  }

  fill(square: Square, colour: string, alpha: MarkAlpha, clear = false): void {
    const { territory } = this;
    const polygons =
      clear || this.inland(square.points)
        ? square.polygon
        : clipPolygons(square.polygon, territory.coast);
    const order = this.marks.length;
    for (const polygon of placePolygons(polygons, territory.x, territory.y)) {
      this.marks.push({
        alpha,
        colour,
        kind: "fill",
        on: territory,
        order,
        polygon,
      } satisfies Fill);
    }
  }

  stroke(
    line: DrawnLine,
    colour: string,
    alpha: MarkAlpha,
    options: { clear?: boolean; dash?: StrokeDash } = {}
  ): void {
    const { clear = false, dash } = options;
    const { territory } = this;
    const pieces =
      clear || this.inland(line.points)
        ? line.pieces
        : clipPolyline(line.points, territory.coast);
    const order = this.marks.length;
    for (const points of placePolylines(pieces, territory.x, territory.y)) {
      this.marks.push({
        alpha,
        cap: "butt",
        colour,
        dash,
        kind: "stroke",
        on: territory,
        order,
        points,
        width: compositionPen,
      } satisfies Stroke);
    }
  }
}

/** A declaration's ink: a blocker's, the evidence's when active, else the declaration's. */
function declarationInk(
  id: string,
  blockers: Set<string>,
  active: Set<string>
): string {
  if (blockers.has(id)) {
    return inks.declarationBlocker;
  }
  if (active.has(id)) {
    return inks.evidence;
  }
  return inks.declaration;
}

/**
 * The square about a point of the frame: kept by the mark it is about while
 * the frame holds the mark at its own place (stationary, or the reveal
 * complete), fresh while the reveal or a trace moves it.
 */
function squareFor(
  source: CompositionMark | undefined,
  at: { x: number; y: number },
  centre: { x: number; y: number },
  side: number
): Square {
  return source && at.x === source.x && at.y === source.y
    ? keptSquare(source, centre.x, centre.y, side)
    : squareAt(centre.x, centre.y, side);
}

/**
 * The composition drawing about its file, in map units, clipped to the coast
 * as the painter clipped it: a paper square under each declaration, its
 * outline, a diagonal through a blocker, and, while a trace moves it, a
 * ghost where it would go with a dashed tether and a paper veil. The reveal
 * with the zoom is the marks' alpha; the spread is in their positions, so
 * the layer is built again as the zoom changes while a drawing shows, and
 * the squares of the marks at rest keep their identity through it.
 */
export function compositionMarks(
  overlay: ResponsibilityOverlay,
  pixels: number,
  territory: Territory
): Mark[] {
  const { composition } = overlay;
  const file = territory.files.find((item) => item.id === composition?.fileId);
  if (!(composition && file && compositionReveal(pixels).detail > 0)) {
    return [];
  }
  const drawing = new CompositionDrawing(territory);
  const active = new Set(composition.active);
  const blockers = new Set(overlay.trace?.blockers ?? []);
  const sources = new Map(composition.marks.map((mark) => [mark.id, mark]));
  const targets = new Map(overlay.trace?.marks.map((mark) => [mark.id, mark]));
  const proposal = dashOf(inkStyle("inspection-proposal"));
  for (const mark of compositionFrame(overlay, pixels)) {
    const source = sources.get(mark.id);
    const centre = { x: file.x + mark.x, y: file.y + mark.y };
    const { x, y } = centre;
    // The paper square is the widest mark about the point: clear of the coast, the rest are too.
    const clear = drawing.clear(x, y, compositionSquare.paper);
    drawing.fill(
      squareFor(source, mark, centre, compositionSquare.paper),
      inks.paper,
      drawing.alpha(1),
      clear
    );
    const ink = declarationInk(mark.id, blockers, active);
    drawing.stroke(
      squareFor(source, mark, centre, compositionSquare.outline),
      ink,
      drawing.alpha(1),
      { clear }
    );
    if (blockers.has(mark.id)) {
      drawing.stroke(
        lineOf([
          x - blockerReach,
          y - blockerReach,
          x + blockerReach,
          y + blockerReach,
        ]),
        ink,
        drawing.alpha(1),
        { clear }
      );
    }
    if (mark.ghost) {
      const { alpha, tether } = mark.ghost;
      const target = targets.get(mark.id);
      const ghostCentre = {
        x: file.x + mark.ghost.x,
        y: file.y + mark.ghost.y,
      };
      const ghostClear = drawing.clear(
        ghostCentre.x,
        ghostCentre.y,
        compositionSquare.ghost
      );
      if (tether) {
        drawing.stroke(
          lineOf([x, y, ghostCentre.x, ghostCentre.y]),
          inks.evidence,
          drawing.alpha(alpha),
          { dash: proposal }
        );
      }
      const ghost = squareFor(
        target,
        mark.ghost,
        ghostCentre,
        compositionSquare.ghost
      );
      drawing.fill(
        ghost,
        inks.paper,
        drawing.alpha(alpha * inkAlpha.paperVeil),
        ghostClear
      );
      drawing.stroke(ghost, inks.evidence, drawing.alpha(alpha), {
        clear: ghostClear,
        dash: proposal,
      });
    }
  }
  return drawing.marks;
}
