import { contours } from "d3-contour";
import { dependencyPen } from "../codex/bindings";
import { shoreDistances } from "../distance-field";
import type { AtlasData, AtlasRoute, Territory } from "../types";
import type { MapLabel } from "./exploration";
import { traceLand } from "./paint-paper";

type Point = [number, number];

/** Offshore distance of the selection ring, in map units. */
export const selectionOffset = 5;
const ringCell = 1;
/** Clearance between a dependency line's ends and each coast. */
const linkClearance = 7;
/** Sideways bow of a dependency curve, as a fraction of its length. */
const linkBow = 0.12;

const gilt = "#b38a32";
const rings = new WeakMap<Territory, Point[][]>();

/** Even-odd scanline fill of the coast on a local grid; no canvas required. */
function landMask(
  territory: Territory,
  left: number,
  top: number,
  width: number,
  height: number
) {
  const land = new Uint8Array(width * height);
  const edges = territory.coast.flatMap((polygon) =>
    polygon.flatMap((ring) =>
      ring
        .slice(1)
        .map((b, i): [Point, Point] => [ring[i] as Point, b as Point])
    )
  );
  for (let row = 0; row < height; row += 1) {
    const y = top + (row + 0.5) * ringCell;
    const crossings: number[] = [];
    for (const [a, b] of edges) {
      if (a[1] > y !== b[1] > y) {
        crossings.push(a[0] + ((y - a[1]) * (b[0] - a[0])) / (b[1] - a[1]));
      }
    }
    crossings.sort((p, q) => p - q);
    for (let i = 0; i + 1 < crossings.length; i += 2) {
      const from = Math.max(
        0,
        Math.ceil(((crossings[i] ?? 0) - left) / ringCell - 0.5)
      );
      const to = Math.min(
        width - 1,
        Math.floor(((crossings[i + 1] ?? 0) - left) / ringCell - 0.5)
      );
      land.fill(1, row * width + from, row * width + to + 1);
    }
  }
  return land;
}

/**
 * The selected island's surround: the contour `selectionOffset` units offshore
 * of its own coast, in world coordinates. Built once per island.
 */
export function selectionRing(territory: Territory): Point[][] {
  const cached = rings.get(territory);
  if (cached) {
    return cached;
  }
  const points = territory.coast.flat(2);
  if (!points.length) {
    rings.set(territory, []);
    return [];
  }
  const margin = selectionOffset + 4;
  const left = Math.min(...points.map(([x]) => x)) - margin;
  const top = Math.min(...points.map(([, y]) => y)) - margin;
  const width = Math.ceil(
    (Math.max(...points.map(([x]) => x)) + margin - left) / ringCell
  );
  const height = Math.ceil(
    (Math.max(...points.map(([, y]) => y)) + margin - top) / ringCell
  );
  const distances = shoreDistances(
    landMask(territory, left, top, width, height),
    width,
    height
  );
  const [band] = contours()
    .size([width, height])
    .thresholds([selectionOffset / ringCell])(Array.from(distances));
  const result = (band?.coordinates.flat() ?? [])
    .filter((ring) =>
      ring.every(
        ([x = 0, y = 0]) =>
          x > 0.5 && y > 0.5 && x < width - 0.5 && y < height - 0.5
      )
    )
    .map((ring) =>
      ring.map(
        ([x = 0, y = 0]): Point => [
          territory.x + left + x * ringCell,
          territory.y + top + y * ringCell,
        ]
      )
    );
  rings.set(territory, result);
  return result;
}

export interface DependencyLink {
  control: Point;
  end: Point;
  /** True when the selected package imports from the other; false for a dependent. */
  outgoing: boolean;
  route: AtlasRoute;
  start: Point;
}

function nearestCoasts(a: Territory, b: Territory): [Point, Point] {
  const outline = (territory: Territory) =>
    territory.coast.flatMap((polygon) =>
      (polygon[0] ?? []).map(
        ([x, y]): Point => [territory.x + x, territory.y + y]
      )
    );
  const from = outline(a);
  const to = outline(b);
  let best: [Point, Point] = [
    [a.x, a.y],
    [b.x, b.y],
  ];
  let distance = Number.POSITIVE_INFINITY;
  for (const p of from) {
    for (const q of to) {
      const d = (p[0] - q[0]) ** 2 + (p[1] - q[1]) ** 2;
      if (d < distance) {
        distance = d;
        best = [p, q];
      }
    }
  }
  return best;
}

const links = new WeakMap<AtlasData, Map<string, DependencyLink[]>>();

/** Gentle curves between nearest shores; built once per selected package. */
export function dependencyLinks(
  data: AtlasData,
  selected: string
): DependencyLink[] {
  const cache = links.get(data) ?? new Map<string, DependencyLink[]>();
  links.set(data, cache);
  const cached = cache.get(selected);
  if (cached) {
    return cached;
  }
  const territories = new Map(data.territories.map((t) => [t.id, t]));
  const origin = territories.get(selected);
  const result: DependencyLink[] = [];
  for (const route of data.routes) {
    const outgoing = route.from === selected;
    const other = territories.get(outgoing ? route.to : route.from);
    if (!(origin && other && (outgoing || route.to === selected))) {
      continue;
    }
    const [a, b] = nearestCoasts(origin, other);
    const length = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
    const ux = (b[0] - a[0]) / length;
    const uy = (b[1] - a[1]) / length;
    const start: Point = [a[0] + ux * linkClearance, a[1] + uy * linkClearance];
    const end: Point = [b[0] - ux * linkClearance, b[1] - uy * linkClearance];
    const bow = linkBow * Math.max(0, length - 2 * linkClearance);
    result.push({
      control: [
        (start[0] + end[0]) / 2 - uy * bow,
        (start[1] + end[1]) / 2 + ux * bow,
      ],
      end,
      outgoing,
      route,
      start,
    });
  }
  cache.set(selected, result);
  return result;
}

/**
 * Selection ink: a gilt ring around the selected island and dashed gilt
 * curves to the packages it imports from (finer dots from its dependents).
 * Lines pass beneath other islands; they are sea ink only.
 */
export function paintSelectionInk(
  ctx: CanvasRenderingContext2D,
  data: AtlasData,
  selected: string | null,
  pixels: number,
  labels: readonly MapLabel[] = []
) {
  const territory = data.territories.find((t) => t.id === selected);
  if (!(territory && selected)) {
    return;
  }
  const routes = dependencyLinks(data, selected);
  const strongest = Math.max(1, ...routes.map((link) => link.route.weight));
  ctx.save();
  ctx.beginPath();
  ctx.rect(-data.width, -data.height, data.width * 2, data.height * 2);
  traceLand(ctx, data);
  // Names stay clear: each label box is cut from the sea ink.
  for (const label of labels) {
    ctx.rect(
      label.x - label.width / 2 - 4 / pixels,
      label.y - label.height - 4 / pixels,
      label.width + 8 / pixels,
      label.height + (label.caption ? 18 : 8) / pixels
    );
  }
  ctx.clip("evenodd");
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  ctx.strokeStyle = gilt;
  for (const link of routes) {
    ctx.globalAlpha = link.outgoing ? 0.85 : 0.7;
    ctx.lineWidth = dependencyPen(link.route.weight, strongest) / pixels;
    ctx.setLineDash(
      link.outgoing ? [7 / pixels, 5 / pixels] : [0.1 / pixels, 4 / pixels]
    );
    ctx.beginPath();
    ctx.moveTo(...link.start);
    ctx.quadraticCurveTo(...link.control, ...link.end);
    ctx.stroke();
    ctx.setLineDash([]);
    // A small gilt bead marks the other package's end of each line.
    ctx.beginPath();
    ctx.arc(...link.end, 2.2 / pixels, 0, Math.PI * 2);
    ctx.fillStyle = gilt;
    ctx.fill();
  }
  ctx.globalAlpha = 0.95;
  ctx.setLineDash([]);
  ctx.lineWidth = 1.8 / pixels;
  for (const ring of selectionRing(territory)) {
    ctx.beginPath();
    for (const [index, [x, y]] of ring.entries()) {
      if (index) {
        ctx.lineTo(x, y);
      } else {
        ctx.moveTo(x, y);
      }
    }
    ctx.closePath();
    ctx.stroke();
  }
  ctx.restore();
}
