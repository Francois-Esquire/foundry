import type { Polygon, SpyglassFile, Territory } from "../data/types";
import { inkAlpha, inkStyle, inks } from "../ladder/ink-ladder";
import { detailLevel } from "../view/detail-level";
import { clipPolygons, clipPolyline } from "./clip";
import { compositionFrame, compositionReveal } from "./composition-motion";
import { clearOfCoast, compositionInsideLand } from "./composition-placement";
import type { Fill, Glyph, Mark, MarkAlpha, Stroke } from "./marks";
import { dashOf } from "./marks";
import { insidePolygons } from "./polygons";
import type { ResponsibilityOverlay } from "./responsibility-focus";
import type { RouteEndpoint } from "./scenario-routes";

/** What the overlay's marks are built from: the selected island and its overlay, at the zoom the screen-sized lines are laid for. */
export interface ResponsibilityMarkInputs {
  overlay: ResponsibilityOverlay;
  /** The zoom the marks are built for: the arcs, arrowheads and diamonds are laid in world units at it. */
  pixels: number;
  territory: Territory;
}

/** The composition's squares, in map units: the paper under a declaration, its outline, and a ghost's. */
const compositionSquare = { ghost: 1.2, outline: 1, paper: 1.6 } as const;
/** The composition's pen, in CSS pixels. */
const compositionPen = 1;
/** The screen-sized marks round a file, in CSS pixels. */
const fileRings = {
  arrow: 5,
  hint: 5,
  member: 3.5,
  notch: { from: 2, to: 6 },
  related: 2.5,
  route: 6,
  unresolved: 6,
} as const;
/** The hint's arc, in canvas radians: open toward the north-east. */
const hintArc = { from: 0.3, to: Math.PI * 1.6 } as const;
/** How many routes of each kind are drawn. */
const routeBudget = 64;
/** The arrowhead's half angle, in radians. */
const arrowSpread = 0.5;

/** The composition's reveal with the zoom, and the files' detail with or without a composition: shared, so the renderer batches by them. */
const compositionDetail: MarkAlpha = (pixels) =>
  compositionReveal(pixels).detail;
const filesDetail: MarkAlpha = (pixels) => detailLevel(pixels, false).files;
const filesDetailUnderComposition: MarkAlpha = (pixels) =>
  detailLevel(pixels, true).files;

/** Whether the overlay has anything laid in world units at the zoom, so its layer is built again as the zoom changes. */
export function responsibilityFollowsZoom(
  overlay: ResponsibilityOverlay
): boolean {
  return (
    (overlay.composition?.marks.length ?? 0) > 0 ||
    (overlay.hints?.length ?? 0) > 0 ||
    overlay.unresolved.length > 0 ||
    overlay.routes !== undefined
  );
}

/** A square's closed ring about a point, in the given units. */
function squareRing(x: number, y: number, side: number): Polygon[number] {
  const half = side / 2;
  return [
    [x - half, y - half],
    [x + half, y - half],
    [x + half, y + half],
    [x - half, y + half],
    [x - half, y - half],
  ];
}

/** A ring as a flat polyline. */
function flat(ring: Polygon[number]): number[] {
  return ring.flat();
}

/** Island-local points moved onto the chart. */
function place(points: readonly number[], territory: Territory): number[] {
  return points.map((value, i) =>
    i % 2 ? value + territory.y : value + territory.x
  );
}

/** An island-local polygon moved onto the chart. */
function placePolygon(polygon: Polygon, territory: Territory): Polygon {
  return polygon.map((ring) =>
    ring.map(([x, y]): [number, number] => [x + territory.x, y + territory.y])
  );
}

/** The composition's marks on one island: what the clip to its coast would have hidden is cut away here. */
class CompositionDrawing {
  private readonly alphas = new Map<number, MarkAlpha>();
  readonly marks: Mark[] = [];
  private readonly territory: Territory;

  constructor(territory: Territory) {
    this.territory = territory;
  }

  /** The reveal's detail scaled by a ghost's strength, one function per strength, so ghosts alike share a batch. */
  alpha(scale: number): MarkAlpha {
    if (scale === 1) {
      return compositionDetail;
    }
    let alpha = this.alphas.get(scale);
    if (!alpha) {
      alpha = (pixels) => compositionReveal(pixels).detail * scale;
      this.alphas.set(scale, alpha);
    }
    return alpha;
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

  /** Whether every corner of a ring lies on land, for a mark not known to be clear. */
  private inland(ring: Polygon[number]): boolean {
    return ring.every(([x, y]) =>
      insidePolygons({ x, y }, this.territory.coast)
    );
  }

  fill(
    ring: Polygon[number],
    colour: string,
    alpha: MarkAlpha,
    clear = false
  ): void {
    const polygons =
      clear || this.inland(ring)
        ? [[ring]]
        : clipPolygons([[ring]], this.territory.coast);
    for (const polygon of polygons) {
      this.marks.push({
        alpha,
        colour,
        kind: "fill",
        on: this.territory,
        polygon: placePolygon(polygon, this.territory),
      } satisfies Fill);
    }
  }

  stroke(
    points: readonly number[],
    colour: string,
    alpha: MarkAlpha,
    options: { clear?: boolean; dash?: readonly [number, number] } = {}
  ): void {
    const { clear = false, dash } = options;
    const ring: Polygon[number] = [];
    for (let i = 0; i + 1 < points.length; i += 2) {
      ring.push([points[i] ?? 0, points[i + 1] ?? 0]);
    }
    const pieces =
      clear || this.inland(ring)
        ? [points]
        : clipPolyline(points, this.territory.coast);
    for (const piece of pieces) {
      this.marks.push({
        alpha,
        cap: "butt",
        colour,
        dash,
        kind: "stroke",
        on: this.territory,
        points: place(piece, this.territory),
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
 * The composition drawing about its file, in map units, clipped to the coast
 * as the painter clipped it: a paper square under each declaration, its
 * outline, a diagonal through a blocker, and, while a trace moves it, a
 * ghost where it would go with a dashed tether and a paper veil. The reveal
 * with the zoom is the marks' alpha; the spread is in their positions, so
 * the layer is built again as the zoom changes while a drawing shows.
 */
function compositionMarks(inputs: ResponsibilityMarkInputs): Mark[] {
  const { overlay, pixels, territory } = inputs;
  const { composition } = overlay;
  const file = territory.files.find((item) => item.id === composition?.fileId);
  if (!(composition && file && compositionReveal(pixels).detail > 0)) {
    return [];
  }
  const drawing = new CompositionDrawing(territory);
  const active = new Set(composition.active);
  const blockers = new Set(overlay.trace?.blockers ?? []);
  const proposal = inkStyle("inspection-proposal");
  for (const mark of compositionFrame(overlay, pixels)) {
    const x = file.x + mark.x;
    const y = file.y + mark.y;
    // The paper square is the widest mark about the point: clear of the coast, the rest are too.
    const clear = drawing.clear(x, y, compositionSquare.paper);
    drawing.fill(
      squareRing(x, y, compositionSquare.paper),
      inks.paper,
      drawing.alpha(1),
      clear
    );
    const ink = declarationInk(mark.id, blockers, active);
    drawing.stroke(
      flat(squareRing(x, y, compositionSquare.outline)),
      ink,
      drawing.alpha(1),
      { clear }
    );
    if (blockers.has(mark.id)) {
      drawing.stroke(
        [x - 0.5, y - 0.5, x + 0.5, y + 0.5],
        ink,
        drawing.alpha(1),
        { clear }
      );
    }
    if (mark.ghost) {
      const { alpha, tether } = mark.ghost;
      const tx = file.x + mark.ghost.x;
      const ty = file.y + mark.ghost.y;
      const ghostClear = drawing.clear(tx, ty, compositionSquare.ghost);
      if (tether) {
        drawing.stroke([x, y, tx, ty], inks.evidence, drawing.alpha(alpha), {
          dash: dashOf(proposal),
        });
      }
      drawing.fill(
        squareRing(tx, ty, compositionSquare.ghost),
        inks.paper,
        drawing.alpha(alpha * inkAlpha.paperVeil),
        ghostClear
      );
      drawing.stroke(
        flat(squareRing(tx, ty, compositionSquare.ghost)),
        inks.evidence,
        drawing.alpha(alpha),
        { clear: ghostClear, dash: dashOf(proposal) }
      );
    }
  }
  return drawing.marks;
}

/** Where a route ends: a file, or the centroid of a responsibility's files. */
function endpointOf(
  endpoint: RouteEndpoint,
  files: Map<string, SpyglassFile>,
  routes: NonNullable<ResponsibilityOverlay["routes"]>
): { x: number; y: number } | undefined {
  if (endpoint.kind === "file") {
    return files.get(endpoint.id);
  }
  const members =
    routes.scopes
      .find((scope) => scope.id === endpoint.id)
      ?.files.flatMap((id) => files.get(id) ?? []) ?? [];
  return members.length
    ? {
        x: members.reduce((sum, file) => sum + file.x, 0) / members.length,
        y: members.reduce((sum, file) => sum + file.y, 0) / members.length,
      }
    : undefined;
}

/**
 * A scenario's routes: the current ones faint and the proposed ones coming
 * in with the scenario's progress, each a dashed line ending in a ring on
 * a responsibility or an arrowhead on a file. The ring is a glyph; the
 * arrowhead is laid in world units at the zoom.
 */
function routeMarks(
  inputs: ResponsibilityMarkInputs,
  files: Map<string, SpyglassFile>
): Mark[] {
  const { overlay, pixels, territory } = inputs;
  const { routes } = overlay;
  if (!routes) {
    return [];
  }
  const marks: Mark[] = [];
  const arm = fileRings.arrow / pixels;
  for (const [links, style, alpha] of [
    [routes.baseline, inkStyle("scenario-baseline"), inkAlpha.scenarioBaseline],
    [routes.proposed, inkStyle("scenario-proposed"), routes.progress],
  ] as const) {
    const pen = {
      alpha,
      cap: "butt",
      colour: style.hue,
      dash: dashOf(style),
      kind: "stroke",
      on: territory,
      width: style.weight,
    } as const;
    for (const route of links.slice(0, routeBudget)) {
      const source = endpointOf(route.source, files, routes);
      const target = endpointOf(route.target, files, routes);
      if (!(source && target)) {
        continue;
      }
      marks.push({
        ...pen,
        points: place([source.x, source.y, target.x, target.y], territory),
      });
      if (route.target.kind === "responsibility") {
        marks.push({
          alpha,
          colour: style.hue,
          kind: "glyph",
          on: territory,
          shape: "hoop",
          size: 2 * fileRings.route,
          weight: style.weight,
          x: territory.x + target.x,
          y: territory.y + target.y,
        } satisfies Glyph);
      } else {
        const angle = Math.atan2(target.y - source.y, target.x - source.x);
        marks.push({
          ...pen,
          points: place(
            [
              target.x - Math.cos(angle - arrowSpread) * arm,
              target.y - Math.sin(angle - arrowSpread) * arm,
              target.x,
              target.y,
              target.x - Math.cos(angle + arrowSpread) * arm,
              target.y - Math.sin(angle + arrowSpread) * arm,
            ],
            territory
          ),
        });
      }
    }
  }
  return marks;
}

/** An arc about a point as a polyline, in canvas radians (clockwise on the chart, whose y runs south). */
function arcPoints(
  x: number,
  y: number,
  radius: number,
  from: number,
  to: number,
  segments = 16
): number[] {
  const points: number[] = [];
  for (let i = 0; i <= segments; i += 1) {
    const angle = from + ((to - from) * i) / segments;
    points.push(x + radius * Math.cos(angle), y + radius * Math.sin(angle));
  }
  return points;
}

/** A dotted arc round each file the overlay suggests looking at, laid in world units at the zoom. */
function hintMarks(
  inputs: ResponsibilityMarkInputs,
  files: Map<string, SpyglassFile>
): Stroke[] {
  const { overlay, pixels, territory } = inputs;
  const hint = inkStyle("inspection-hint");
  const marks: Stroke[] = [];
  for (const id of overlay.hints ?? []) {
    const file = files.get(id);
    if (!file) {
      continue;
    }
    marks.push({
      alpha: 1,
      cap: "butt",
      colour: hint.hue,
      dash: dashOf(hint),
      kind: "stroke",
      on: territory,
      points: place(
        arcPoints(
          file.x,
          file.y,
          fileRings.hint / pixels,
          hintArc.from,
          hintArc.to
        ),
        territory
      ),
      width: hint.weight,
    });
  }
  return marks;
}

/** A dashed link between two evidence files. */
function linkMarks(
  inputs: ResponsibilityMarkInputs,
  files: Map<string, SpyglassFile>
): Stroke[] {
  const { overlay, territory } = inputs;
  const link = inkStyle("inspection-link");
  const marks: Stroke[] = [];
  for (const { source, target } of overlay.links) {
    const a = files.get(source);
    const b = files.get(target);
    if (!(a && b)) {
      continue;
    }
    marks.push({
      alpha: inkAlpha.inspectionLink,
      cap: "butt",
      colour: link.hue,
      dash: dashOf(link),
      kind: "stroke",
      on: territory,
      points: place([a.x, a.y, b.x, b.y], territory),
      width: link.weight,
    });
  }
  return marks;
}

/**
 * The overlay's entries, at the files' detail: a ring round each related
 * file and a larger one round each member, a notch toward the north-east on
 * a file whose folder disagrees with its responsibility, and a dashed
 * diamond round an unresolved file, laid in world units at the zoom.
 */
function entryMarks(
  inputs: ResponsibilityMarkInputs,
  files: Map<string, SpyglassFile>
): Mark[] {
  const { overlay, pixels, territory } = inputs;
  const alpha =
    (overlay.composition?.marks.length ?? 0) > 0
      ? filesDetailUnderComposition
      : filesDetail;
  const marks: Mark[] = [];
  const at = (file: SpyglassFile) =>
    ({
      alpha,
      kind: "glyph",
      on: territory,
      x: territory.x + file.x,
      y: territory.y + file.y,
    }) as const;
  for (const [ids, style, radius] of [
    [overlay.related, inkStyle("inspection-related"), fileRings.related],
    [overlay.members, inkStyle("inspection-focus"), fileRings.member],
  ] as const) {
    for (const id of ids) {
      const file = files.get(id);
      if (file) {
        marks.push({
          ...at(file),
          colour: style.hue,
          shape: "hoop",
          size: 2 * radius,
          weight: style.weight,
        });
      }
    }
  }
  const notch = inkStyle("inspection-notch");
  for (const id of overlay.pathDisagreement) {
    const file = files.get(id);
    if (file) {
      marks.push({
        ...at(file),
        colour: inks.inspectionWarning,
        shape: "notch",
        size: fileRings.notch.to + fileRings.notch.from,
        weight: notch.weight,
      });
    }
  }
  const unresolved = inkStyle("inspection-unresolved");
  const r = fileRings.unresolved / pixels;
  for (const id of overlay.unresolved) {
    const file = files.get(id);
    if (file) {
      marks.push({
        alpha,
        cap: "butt",
        colour: inks.inspectionWarning,
        dash: dashOf(unresolved),
        kind: "stroke",
        on: territory,
        points: place(
          [
            file.x,
            file.y - r,
            file.x + r,
            file.y,
            file.x,
            file.y + r,
            file.x - r,
            file.y,
            file.x,
            file.y - r,
          ],
          territory
        ),
        width: unresolved.weight,
      } satisfies Stroke);
    }
  }
  return marks;
}

/**
 * The architectural overlay of the selected island's responsibility, every
 * mark draped on its relief: the composition drawing, the scenario's
 * routes, the hints, the links between evidence files, and the entries.
 * The overlay's animations (a route's and a trace's progress) arrive as a
 * new overlay and rebuild the layer; the arcs, arrowheads and diamonds
 * are laid in world units at the zoom, so the layer is built again as the
 * zoom changes while the overlay has any (`responsibilityFollowsZoom`).
 */
export function responsibilityMarks(inputs: ResponsibilityMarkInputs): Mark[] {
  const files = new Map(inputs.territory.files.map((file) => [file.id, file]));
  return [
    ...compositionMarks(inputs),
    ...routeMarks(inputs, files),
    ...hintMarks(inputs, files),
    ...linkMarks(inputs, files),
    ...entryMarks(inputs, files),
  ];
}
