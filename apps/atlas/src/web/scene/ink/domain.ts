import { placementKey } from "../../codex/resolve";
import { departures } from "../../departures";
import type { DomainIsland } from "../../domain-extent";
import type { Rect } from "../../folder-sectors";
import type { Territory } from "../../types";
import { tiltStretch as stretch } from "../exploration";
import { dashAt, departureRing, domainMark, inkStyle } from "../ink-ladder";
import { cellsShown, inView } from "./folders";
import type { InkState } from "./state";

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

function traceCoast(ctx: CanvasRenderingContext2D, territory: Territory) {
  for (const polygon of territory.coast) {
    for (const ring of polygon) {
      for (const [index, [x, y]] of ring.entries()) {
        const at: [number, number] = [
          territory.x + x,
          (territory.y + y) / stretch,
        ];
        if (index) {
          ctx.lineTo(...at);
        } else {
          ctx.moveTo(...at);
        }
      }
      ctx.closePath();
    }
  }
}

/**
 * The band inside the edge of what the domain covers on one island: the
 * land of its cells' regions, or the whole island. Clipped to that shape
 * and stroked at twice the band's width, only the inner half shows.
 */
function paintBand(
  ctx: CanvasRenderingContext2D,
  island: DomainIsland,
  box: Rect | undefined,
  pixels: number
) {
  const { territory } = island;
  const pen = inkStyle("domain-outline");
  ctx.save();
  ctx.scale(1, stretch);
  ctx.beginPath();
  traceCoast(ctx, territory);
  ctx.clip("evenodd");
  const rects = island.cells.map((cell) =>
    box ? toCoast(cell.region, box, territory.radius * 2) : cell.region
  );
  if (!island.whole) {
    ctx.beginPath();
    for (const rect of rects) {
      ctx.rect(
        territory.x + rect.x0,
        (territory.y + rect.y0) / stretch,
        rect.x1 - rect.x0,
        (rect.y1 - rect.y0) / stretch
      );
    }
    ctx.clip();
  }
  ctx.beginPath();
  traceCoast(ctx, territory);
  for (const [x0, y0, x1, y1] of island.whole ? [] : unionOutline(rects)) {
    ctx.moveTo(territory.x + x0, (territory.y + y0) / stretch);
    ctx.lineTo(territory.x + x1, (territory.y + y1) / stretch);
  }
  ctx.strokeStyle = pen.hue;
  ctx.lineWidth = (2 * pen.weight) / pixels;
  ctx.lineCap = "butt";
  ctx.setLineDash(dashAt(pen, pixels));
  ctx.stroke();
  ctx.restore();
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

/** A package covered whole: a filled diamond inside its southern coast, away from its name in the north. */
function paintPackageMark(
  ctx: CanvasRenderingContext2D,
  territory: Territory,
  pixels: number
) {
  const [sx, sy] = southOf(territory);
  const x = territory.x + sx;
  const y = territory.y + sy - domainMark.inset / pixels;
  const half = domainMark.diamond / pixels;
  ctx.fillStyle = inkStyle("domain-package").hue;
  ctx.beginPath();
  ctx.moveTo(x, y - half);
  ctx.lineTo(x + half, y);
  ctx.lineTo(x, y + half);
  ctx.lineTo(x - half, y);
  ctx.closePath();
  ctx.fill();
}

/**
 * A file the domain names alone: a square round its mark, its east–west
 * sides widened for the tilt as the band's are, since they otherwise never
 * reach the ink on screen.
 */
function paintFileSquares(
  ctx: CanvasRenderingContext2D,
  island: DomainIsland,
  pixels: number
) {
  const pen = inkStyle("domain-file");
  const half = domainMark.fileSquare / pixels;
  ctx.save();
  ctx.scale(1, stretch);
  ctx.strokeStyle = pen.hue;
  ctx.lineWidth = pen.weight / pixels;
  ctx.setLineDash([]);
  for (const file of island.files) {
    ctx.strokeRect(
      island.territory.x + file.x - half,
      (island.territory.y + file.y - half) / stretch,
      2 * half,
      (2 * half) / stretch
    );
  }
  ctx.restore();
}

/**
 * A chosen domain across the islands (`domain-extent.ts`): a dashed band
 * inside the edge of the folder cells it covers on each island, joined into
 * one outline, or along the whole coast of a package it covers whole, which
 * also takes a diamond; a square round each file it names alone. Nothing
 * without a chosen domain. On an island "Group files by responsibility" has
 * rearranged, the cells and files are not drawn, since its files no longer
 * sit in them; a package covered whole keeps its coast and mark. Its name is
 * a label (`labels.ts`), and the departures it explains are marked over
 * their rings (`paintDomainDepartures`).
 */
export function paintDomain(state: InkState): void {
  const { belonging, ctx, data, domain, pixels, view } = state;
  if (!domain) {
    return;
  }
  for (const island of domain.islands) {
    const { territory } = island;
    if (!inView(territory, view)) {
      continue;
    }
    const box = data.folderCells[territory.id]?.region;
    if (island.whole) {
      paintBand(ctx, island, box, pixels);
      paintPackageMark(ctx, territory, pixels);
      continue;
    }
    if (!cellsShown(territory, belonging)) {
      continue;
    }
    if (island.cells.length) {
      paintBand(ctx, island, box, pixels);
    }
    paintFileSquares(ctx, island, pixels);
  }
}

/**
 * The departures a chosen domain explains, their domain label
 * `shares-domain` with it among the shared: the notch of each ring is
 * closed in the domain's ink, heavier than the ring, so the ring still
 * reads as a departure and the plug as the domain's. A domain departure
 * takes nothing more.
 */
export function paintDomainDepartures(state: InkState): void {
  const { ctx, data, domain, pixels } = state;
  if (!domain?.explained.size) {
    return;
  }
  const pen = inkStyle("domain-explained");
  // Under the departures' own stretch, so the plug meets its ring.
  ctx.save();
  ctx.scale(1, stretch);
  ctx.strokeStyle = pen.hue;
  ctx.lineWidth = pen.weight / pixels;
  ctx.lineCap = "butt";
  ctx.setLineDash([]);
  for (const mark of departures(data).marks) {
    if (!domain.explained.has(placementKey(mark))) {
      continue;
    }
    ctx.beginPath();
    ctx.arc(
      mark.x,
      mark.y / stretch,
      departureRing.radius[mark.level] / pixels,
      -Math.PI / 2 - departureRing.notch / 2,
      -Math.PI / 2 + departureRing.notch / 2
    );
    ctx.stroke();
  }
  ctx.restore();
}
