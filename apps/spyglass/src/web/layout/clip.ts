import { intersection } from "polygon-clipping";
import type { Polygon } from "../data/types";
import { insidePolygons } from "./polygons";

/**
 * Clipping as geometry. The painters clipped with the canvas: a district to
 * its coast, the domain's band to its cells, a cut to the land. A mark is
 * drawn whole, so what the clip would have hidden is cut away here instead:
 * a fill by polygon intersection, a polyline by keeping the pieces that lie
 * inside. Both are even-odd over every ring, as the canvas clips were.
 */

const clippedPolygons = new WeakMap<Polygon[], WeakMap<Polygon[], Polygon[]>>();

/**
 * The part of `subject` inside `clip`, as polygons (outer ring first, then
 * holes; each ring closed on its first point). Kept by the identity of both,
 * so a layer that rebuilds with the same polygons gets the same result, and
 * the draping cached on it.
 */
export function clipPolygons(subject: Polygon[], clip: Polygon[]): Polygon[] {
  if (!(subject.length && clip.length)) {
    return [];
  }
  let bySubject = clippedPolygons.get(subject);
  if (!bySubject) {
    bySubject = new WeakMap();
    clippedPolygons.set(subject, bySubject);
  }
  const known = bySubject.get(clip);
  if (known) {
    return known;
  }
  const result = intersection(subject, clip);
  bySubject.set(clip, result);
  return result;
}

/** Every ring edge of a clip as a flat run: ax, ay, bx, by. */
const clipEdges = new WeakMap<Polygon[], Float64Array>();

function edgesOf(clip: Polygon[]): Float64Array {
  let edges = clipEdges.get(clip);
  if (edges) {
    return edges;
  }
  const runs: number[] = [];
  for (const polygon of clip) {
    for (const ring of polygon) {
      for (let i = 0; i < ring.length; i += 1) {
        const a = ring[i];
        const b = ring[(i + 1) % ring.length];
        if (a && b) {
          runs.push(a[0], a[1], b[0], b[1]);
        }
      }
    }
  }
  edges = Float64Array.from(runs);
  clipEdges.set(clip, edges);
  return edges;
}

/** Where a segment crosses the clip's edges, as its parameters in (0, 1), ascending. */
function crossings(
  ax: number,
  ay: number,
  bx: number,
  by: number,
  edges: Float64Array
): number[] {
  const rx = bx - ax;
  const ry = by - ay;
  const left = Math.min(ax, bx);
  const right = Math.max(ax, bx);
  const top = Math.min(ay, by);
  const bottom = Math.max(ay, by);
  const cuts: number[] = [];
  for (let e = 0; e + 3 < edges.length; e += 4) {
    const cx = edges[e] ?? 0;
    const cy = edges[e + 1] ?? 0;
    const dx = edges[e + 2] ?? 0;
    const dy = edges[e + 3] ?? 0;
    if (
      Math.max(cx, dx) < left ||
      Math.min(cx, dx) > right ||
      Math.max(cy, dy) < top ||
      Math.min(cy, dy) > bottom
    ) {
      continue;
    }
    const sx = dx - cx;
    const sy = dy - cy;
    const denominator = rx * sy - ry * sx;
    if (Math.abs(denominator) < 1e-12) {
      continue;
    }
    const t = ((cx - ax) * sy - (cy - ay) * sx) / denominator;
    const u = ((cx - ax) * ry - (cy - ay) * rx) / denominator;
    if (t > 0 && t < 1 && u >= 0 && u <= 1) {
      cuts.push(t);
    }
  }
  return cuts.sort((p, q) => p - q);
}

/**
 * The pieces of a polyline (x, y pairs) that lie inside the clip: each
 * segment is split where it crosses a ring, and a piece is kept when its
 * middle is inside. A region's outline clipped to its coast this way stops
 * at the shore and never strokes the coast itself, as the canvas clip left
 * it.
 */
export function clipPolyline(
  points: readonly number[],
  clip: Polygon[]
): number[][] {
  const edges = edgesOf(clip);
  const pieces: number[][] = [];
  let piece: number[] = [];
  const flush = () => {
    if (piece.length) {
      pieces.push(piece);
      piece = [];
    }
  };
  for (let i = 2; i + 1 < points.length; i += 2) {
    const ax = points[i - 2] ?? 0;
    const ay = points[i - 1] ?? 0;
    const bx = points[i] ?? 0;
    const by = points[i + 1] ?? 0;
    const at = (t: number): [number, number] => [
      ax + (bx - ax) * t,
      ay + (by - ay) * t,
    ];
    let from = 0;
    for (const to of [...crossings(ax, ay, bx, by, edges), 1]) {
      if (to - from < 1e-9) {
        from = to;
        continue;
      }
      const [mx, my] = at((from + to) / 2);
      if (insidePolygons({ x: mx, y: my }, clip)) {
        if (!piece.length) {
          piece.push(...at(from));
        }
        piece.push(...at(to));
      } else {
        flush();
      }
      from = to;
    }
  }
  flush();
  return pieces;
}
