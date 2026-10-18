import {
  type BufferGeometry,
  Path,
  Shape,
  ShapeGeometry,
  Vector2,
} from "three";
import { TessellateModifier } from "three/addons/modifiers/TessellateModifier.js";
import { mergeVertices } from "three/addons/utils/BufferGeometryUtils.js";
import { paperThickness } from "../../data/bindings";
import type { Polygon, Territory } from "../../data/types";
import { baseTerrainField, terrainCell } from "../../layout/terrain-field";
import { islandTop } from "../../layout/terrain-height";

/** Where a flat mark lies: just above the paper, as the ink plane does. */
export const flatMarkHeight = paperThickness + 0.02;

/** A draped mark sits this far above the relief, as the flat ones do above the paper. */
const drapeLift = 0.02;

/** The height of the relief under a chart point on an island, plus the lift. */
export function drapedHeight(
  territory: Territory,
  x: number,
  y: number
): number {
  return (
    islandTop +
    baseTerrainField(territory).sample(x - territory.x, y - territory.y)
      .elevation +
    drapeLift
  );
}

/**
 * The polyline with every segment cut so none is longer than the terrain's
 * cell: lifted vertex by vertex, it then bends where the relief does, since
 * the relief mesh is cut to the same edge.
 */
export function densify(
  points: readonly number[],
  maxLength = terrainCell
): number[] {
  const out: number[] = [];
  const first = points.slice(0, 2);
  out.push(...first);
  for (let i = 2; i + 1 < points.length; i += 2) {
    const ax = points[i - 2] ?? 0;
    const ay = points[i - 1] ?? 0;
    const bx = points[i] ?? 0;
    const by = points[i + 1] ?? 0;
    const pieces = Math.max(
      1,
      Math.ceil(Math.hypot(bx - ax, by - ay) / maxLength)
    );
    for (let piece = 1; piece <= pieces; piece += 1) {
      const t = piece / pieces;
      out.push(ax + (bx - ax) * t, ay + (by - ay) * t);
    }
  }
  return out;
}

const draped = new WeakMap<readonly number[], Float32Array>();

/**
 * A polyline's vertices in world space (x, −y, z): on the island's relief
 * when draped, else flat on the sea plane. Draping samples the terrain at
 * every cut vertex, so a draped polyline's vertices are kept by its points:
 * a layer that rebuilds with the same polylines pays only for the batching.
 */
export function polylineVertices(
  points: readonly number[],
  on: Territory | undefined
): Float32Array {
  if (!on) {
    return liftPolyline(points, on);
  }
  let vertices = draped.get(points);
  if (!vertices) {
    vertices = liftPolyline(points, on);
    draped.set(points, vertices);
  }
  return vertices;
}

function liftPolyline(
  points: readonly number[],
  on: Territory | undefined
): Float32Array {
  const path = on ? densify(points) : points;
  const vertices = new Float32Array((path.length / 2) * 3);
  for (let i = 0, v = 0; i + 1 < path.length; i += 2, v += 3) {
    const x = path[i] ?? 0;
    const y = path[i + 1] ?? 0;
    vertices[v] = x;
    vertices[v + 1] = -y;
    vertices[v + 2] = on ? drapedHeight(on, x, y) : flatMarkHeight;
  }
  return vertices;
}

/**
 * A polygon as a triangulated geometry in world space: flat on the sea
 * plane, or tessellated to the terrain's cell and lifted onto the island's
 * relief, exactly as the terrain mesh is built.
 */
export function polygonGeometry(
  polygon: Polygon,
  on: Territory | undefined
): BufferGeometry {
  const rings = polygon.map((ring) => ring.map(([x, y]) => new Vector2(x, -y)));
  const [outer = [], ...holes] = rings;
  const shape = new Shape(outer);
  for (const hole of holes) {
    shape.holes.push(new Path(hole));
  }
  const flat = new ShapeGeometry(shape);
  if (!on) {
    flat.translate(0, 0, flatMarkHeight);
    return flat;
  }
  const triangles = new TessellateModifier(terrainCell, 16).modify(flat);
  flat.dispose();
  triangles.deleteAttribute("normal");
  triangles.deleteAttribute("uv");
  const geometry = mergeVertices(triangles);
  triangles.dispose();
  const positions = geometry.getAttribute("position");
  for (let i = 0; i < positions.count; i += 1) {
    const x = positions.getX(i);
    const y = positions.getY(i);
    positions.setZ(i, drapedHeight(on, x, -y));
  }
  positions.needsUpdate = true;
  geometry.computeBoundingSphere();
  return geometry;
}
