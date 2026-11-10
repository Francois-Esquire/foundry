/**
 * Elliptical arcs as cubic curves, following the endpoint-to-centre
 * conversion in the SVG specification (implementation notes, section F.6).
 */
import type { Point, Segment } from "~/typeface/outline";

export interface ArcShape {
  readonly largeArc: boolean;
  readonly rotation: number;
  readonly rx: number;
  readonly ry: number;
  readonly sweep: boolean;
}

interface Centred {
  readonly centre: Point;
  readonly cos: number;
  readonly delta: number;
  readonly rx: number;
  readonly ry: number;
  readonly sin: number;
  readonly start: number;
}

const angleBetween = (ux: number, uy: number, vx: number, vy: number) =>
  Math.atan2(ux * vy - uy * vx, ux * vx + uy * vy);

const centreOf = (from: Point, to: Point, arc: ArcShape): Centred => {
  const phi = (arc.rotation * Math.PI) / 180;
  const cos = Math.cos(phi);
  const sin = Math.sin(phi);
  const halfX = (from.x - to.x) / 2;
  const halfY = (from.y - to.y) / 2;
  const x1 = cos * halfX + sin * halfY;
  const y1 = -sin * halfX + cos * halfY;
  let rx = Math.abs(arc.rx);
  let ry = Math.abs(arc.ry);
  const lambda = (x1 * x1) / (rx * rx) + (y1 * y1) / (ry * ry);
  if (lambda > 1) {
    rx *= Math.sqrt(lambda);
    ry *= Math.sqrt(lambda);
  }
  const numerator = rx * rx * ry * ry - rx * rx * y1 * y1 - ry * ry * x1 * x1;
  const denominator = rx * rx * y1 * y1 + ry * ry * x1 * x1;
  const magnitude =
    denominator === 0 ? 0 : Math.sqrt(Math.max(0, numerator / denominator));
  const signed = arc.largeArc === arc.sweep ? -magnitude : magnitude;
  const cx1 = (signed * rx * y1) / ry;
  const cy1 = (-signed * ry * x1) / rx;
  const start = angleBetween(1, 0, (x1 - cx1) / rx, (y1 - cy1) / ry);
  let delta = angleBetween(
    (x1 - cx1) / rx,
    (y1 - cy1) / ry,
    (-x1 - cx1) / rx,
    (-y1 - cy1) / ry
  );
  if (!arc.sweep && delta > 0) {
    delta -= 2 * Math.PI;
  } else if (arc.sweep && delta < 0) {
    delta += 2 * Math.PI;
  }
  return {
    centre: {
      x: cos * cx1 - sin * cy1 + (from.x + to.x) / 2,
      y: sin * cx1 + cos * cy1 + (from.y + to.y) / 2,
    },
    cos,
    delta,
    rx,
    ry,
    sin,
    start,
  };
};

/** The arc from `from` to `to` as cubics, each spanning a quarter turn or less. */
export const arcToCubics = (
  from: Point,
  to: Point,
  arc: ArcShape
): Segment[] => {
  if (from.x === to.x && from.y === to.y) {
    return [];
  }
  if (arc.rx === 0 || arc.ry === 0) {
    return [{ kind: "line", to }];
  }
  const { centre, cos, delta, rx, ry, sin, start } = centreOf(from, to, arc);
  const pieces = Math.max(1, Math.ceil(Math.abs(delta) / (Math.PI / 2) - 1e-9));
  const step = delta / pieces;
  const handle = (4 / 3) * Math.tan(step / 4);
  const place = (x: number, y: number): Point => ({
    x: centre.x + cos * rx * x - sin * ry * y,
    y: centre.y + sin * rx * x + cos * ry * y,
  });
  const segments: Segment[] = [];
  for (let piece = 0; piece < pieces; piece += 1) {
    const a0 = start + piece * step;
    const a1 = a0 + step;
    segments.push({
      control1: place(
        Math.cos(a0) - handle * Math.sin(a0),
        Math.sin(a0) + handle * Math.cos(a0)
      ),
      control2: place(
        Math.cos(a1) + handle * Math.sin(a1),
        Math.sin(a1) - handle * Math.cos(a1)
      ),
      kind: "cubic",
      to: piece === pieces - 1 ? to : place(Math.cos(a1), Math.sin(a1)),
    });
  }
  return segments;
};
