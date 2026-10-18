import type { Polygon, Rect, SpyglassData, Territory } from "../data/types";
import { domainMark, inkStyle } from "../ladder/ink-ladder";
import type { BelongingLayer } from "./belonging";
import { clipPolyline } from "./clip";
import type { DomainExtent, DomainIsland } from "./domain-extent";
import { cellsShown } from "./folders";
import type { Glyph, Mark, Stroke } from "./marks";
import { placePolylines, ringPoints } from "./marks";

/** One straight run of an outline, in island units: x0, y0, x1, y1. */
type Segment = [number, number, number, number];

/** What is left of [from, to] once each of `cuts` is taken out. */
function subtract(
  from: number,
  to: number,
  cuts: readonly [number, number][]
): [number, number][] {
  let left: [number, number][] = [[from, to]];
  for (const [c0, c1] of cuts) {
    left = left.flatMap(([a, b]): [number, number][] => {
      if (c1 <= a || c0 >= b) {
        return [[a, b]];
      }
      return [
        ...(c0 > a ? [[a, c0] as [number, number]] : []),
        ...(c1 < b ? [[c1, b] as [number, number]] : []),
      ];
    });
  }
  return left;
}

/**
 * The outline of a union of cell regions: every edge of every rectangle,
 * less the stretches another rectangle meets from the other side. Cells of
 * one tree share their cuts' coordinates exactly, so neighbours meet edge
 * to edge and the edge between them drops out.
 */
export function unionOutline(rects: readonly Rect[]): Segment[] {
  const segments: Segment[] = [];
  for (const rect of rects) {
    const others = rects.filter((other) => other !== rect);
    const across = (match: (other: Rect) => boolean): [number, number][] =>
      others.filter(match).map((other) => [other.y0, other.y1]);
    const along = (match: (other: Rect) => boolean): [number, number][] =>
      others.filter(match).map((other) => [other.x0, other.x1]);
    for (const [a, b] of subtract(
      rect.y0,
      rect.y1,
      across((other) => other.x1 === rect.x0)
    )) {
      segments.push([rect.x0, a, rect.x0, b]);
    }
    for (const [a, b] of subtract(
      rect.y0,
      rect.y1,
      across((other) => other.x0 === rect.x1)
    )) {
      segments.push([rect.x1, a, rect.x1, b]);
    }
    for (const [a, b] of subtract(
      rect.x0,
      rect.x1,
      along((other) => other.y1 === rect.y0)
    )) {
      segments.push([a, rect.y0, b, rect.y0]);
    }
    for (const [a, b] of subtract(
      rect.x0,
      rect.x1,
      along((other) => other.y0 === rect.y1)
    )) {
      segments.push([a, rect.y1, b, rect.y1]);
    }
  }
  return segments;
}

/**
 * A cell's region reaching the coast: an edge on the island's box, which the
 * land runs past, is pushed out beyond the island, so a cell at the edge
 * holds the land out to the coast once clipped. Edges inside the box stay,
 * so neighbours still meet exactly.
 */
export function toCoast(rect: Rect, box: Rect, beyond: number): Rect {
  return {
    x0: rect.x0 === box.x0 ? rect.x0 - beyond : rect.x0,
    x1: rect.x1 === box.x1 ? rect.x1 + beyond : rect.x1,
    y0: rect.y0 === box.y0 ? rect.y0 - beyond : rect.y0,
    y1: rect.y1 === box.y1 ? rect.y1 + beyond : rect.y1,
  };
}

/** The southern point of an island's coast, in island units. */
export function southOf(territory: Territory): [number, number] {
  let south: [number, number] = [0, 0];
  for (const polygon of territory.coast) {
    for (const [x, y] of polygon[0] ?? []) {
      if (y > south[1]) {
        south = [x, y];
      }
    }
  }
  return south;
}

/** A rectangle as a closed ring, for clipping against. */
function rectRing(rect: Rect): Polygon {
  return [
    [
      [rect.x0, rect.y0],
      [rect.x1, rect.y0],
      [rect.x1, rect.y1],
      [rect.x0, rect.y1],
      [rect.x0, rect.y0],
    ],
  ];
}

const bandLines = new WeakMap<DomainIsland, number[][]>();

/**
 * The lines of the band on one island, in island units: the whole coast of
 * a package covered whole; otherwise the coast where it runs through the
 * covered cells, and the cells' joined outline where it runs over land.
 * Kept per island of the extent, so a rebuild keeps their draping.
 */
function bandLinesOf(island: DomainIsland, box: Rect | undefined): number[][] {
  let lines = bandLines.get(island);
  if (lines) {
    return lines;
  }
  const { territory } = island;
  const rings = territory.coast.flatMap((polygon) =>
    polygon.map((ring) => ringPoints(ring))
  );
  if (island.whole) {
    lines = rings;
  } else {
    const rects = island.cells.map((cell) =>
      box ? toCoast(cell.region, box, territory.radius * 2) : cell.region
    );
    const cells = rects.map(rectRing);
    lines = [
      ...rings.flatMap((ring) => clipPolyline(ring, cells)),
      ...unionOutline(rects).flatMap((segment) =>
        clipPolyline(segment, territory.coast)
      ),
    ];
  }
  bandLines.set(island, lines);
  return lines;
}

/** A row's dash as a stroke takes it: dash and gap, or solid. */
function dashOf(style: {
  dash: readonly number[];
}): readonly [number, number] | undefined {
  const [dash, gap] = style.dash;
  return dash !== undefined && gap !== undefined ? [dash, gap] : undefined;
}

/**
 * The band inside the edge of what the domain covers on one island, draped
 * on its relief: drawn centred on the edge at the ladder's weight, where
 * the painter stroked twice the width under a clip and showed the inner
 * half.
 */
function bandMarks(island: DomainIsland, box: Rect | undefined): Stroke[] {
  const pen = inkStyle("domain-outline");
  const { territory } = island;
  return placePolylines(bandLinesOf(island, box), territory.x, territory.y).map(
    (points) => ({
      alpha: 1,
      cap: "butt",
      colour: pen.hue,
      dash: dashOf(pen),
      kind: "stroke",
      on: territory,
      points,
      width: pen.weight,
    })
  );
}

/** A package covered whole: a filled diamond inside its southern coast, away from its name in the north. */
function packageMark(territory: Territory): Glyph {
  const [sx, sy] = southOf(territory);
  return {
    alpha: 1,
    colour: inkStyle("domain-package").hue,
    kind: "glyph",
    offset: [0, -domainMark.inset],
    on: territory,
    shape: "diamond",
    size: 2 * domainMark.diamond,
    x: territory.x + sx,
    y: territory.y + sy,
  };
}

/** A file the domain names alone: a square round its mark, upright so it reads square on screen. */
function fileSquares(island: DomainIsland): Glyph[] {
  const pen = inkStyle("domain-file");
  const { territory } = island;
  return island.files.map((file) => ({
    alpha: 1,
    colour: pen.hue,
    kind: "glyph",
    on: territory,
    shape: "frame",
    size: 2 * domainMark.fileSquare + pen.weight,
    upright: true,
    weight: pen.weight,
    x: territory.x + file.x,
    y: territory.y + file.y,
  }));
}

/**
 * A chosen domain across the islands (`domain-extent.ts`): a dashed band
 * inside the edge of the folder cells it covers on each island, joined into
 * one outline, or along the whole coast of a package it covers whole, which
 * also takes a diamond; a square round each file it names alone. Nothing
 * without a chosen domain. On an island "Group files by responsibility" has
 * rearranged, the cells and files are not drawn, since its files no longer
 * sit in them; a package covered whole keeps its coast and mark. Its name is
 * a label (`scene/ink/labels.ts`), and the departures it explains are marked
 * over their rings (`paintDomainDepartures`).
 */
export function domainMarks(
  data: Pick<SpyglassData, "folderCells">,
  domain: DomainExtent | null,
  belonging: Pick<BelongingLayer, "territory"> | null
): Mark[] {
  if (!domain) {
    return [];
  }
  const marks: Mark[] = [];
  for (const island of domain.islands) {
    const { territory } = island;
    const box = data.folderCells[territory.id]?.region;
    if (island.whole) {
      marks.push(...bandMarks(island, box), packageMark(territory));
      continue;
    }
    if (!cellsShown(territory, belonging)) {
      continue;
    }
    if (island.cells.length) {
      marks.push(...bandMarks(island, box));
    }
    marks.push(...fileSquares(island));
  }
  return marks;
}
