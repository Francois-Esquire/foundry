import {
  type BufferGeometry,
  Path,
  Shape,
  ShapeGeometry,
  Vector2,
} from "three";
import { TessellateModifier } from "three/addons/modifiers/TessellateModifier.js";
import { mergeVertices } from "three/addons/utils/BufferGeometryUtils.js";
import type { Polygon, Territory } from "../../data/types";
import type { Stroke } from "../../layout/marks";
import { islandAt } from "../../layout/polygons";
import { terrainCell } from "../../layout/terrain-field";
import { drapedHeight, flatMarkHeight } from "../../layout/terrain-height";

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
const drapedOnChart = new WeakMap<
  readonly number[],
  { territories: readonly Territory[]; vertices: Float32Array }
>();

/**
 * A polyline's vertices in world space (x, −y, z): on the island's relief
 * when draped, on whatever lies under each vertex when draped on the chart
 * (an island's relief, or the sea plane between islands), else flat on the
 * sea plane. Draping samples the terrain at every cut vertex, so a draped
 * polyline's vertices are kept by its points, and by the islands too when
 * on the chart, since a relayout moves them: a layer that rebuilds with the
 * same polylines pays only for the batching.
 */
export function polylineVertices(
  points: readonly number[],
  on: Stroke["on"],
  territories: readonly Territory[] = []
): Float32Array {
  if (!on) {
    return liftPolyline(points);
  }
  if (on === "chart") {
    const known = drapedOnChart.get(points);
    if (known && known.territories === territories) {
      return known.vertices;
    }
    const vertices = liftPolyline(points, (x, y) => {
      const island = islandAt({ x, y }, territories);
      return island ? drapedHeight(island, x, y) : flatMarkHeight;
    });
    drapedOnChart.set(points, { territories, vertices });
    return vertices;
  }
  let vertices = draped.get(points);
  if (!vertices) {
    vertices = liftPolyline(points, (x, y) => drapedHeight(on, x, y));
    draped.set(points, vertices);
  }
  return vertices;
}

/** The polyline's vertices, cut to the terrain's cell and lifted by `height` when draped; flat on the sea plane without. */
function liftPolyline(
  points: readonly number[],
  height?: (x: number, y: number) => number
): Float32Array {
  const path = height ? densify(points) : points;
  const vertices = new Float32Array((path.length / 2) * 3);
  for (let i = 0, v = 0; i + 1 < path.length; i += 2, v += 3) {
    const x = path[i] ?? 0;
    const y = path[i + 1] ?? 0;
    vertices[v] = x;
    vertices[v + 1] = -y;
    vertices[v + 2] = height ? height(x, y) : flatMarkHeight;
  }
  return vertices;
}

const drapedPolygons = new WeakMap<Polygon, BufferGeometry>();
const flatPolygons = new WeakMap<Polygon, BufferGeometry>();

/**
 * A polygon as a triangulated geometry in world space: flat on the sea
 * plane, or tessellated to the terrain's cell and lifted onto the island's
 * relief, exactly as the terrain mesh is built. Kept by the polygon's
 * identity, as draped polylines are, so a layer that rebuilds with the same
 * polygons (the reveal, a hover) never tessellates or samples the relief
 * again; the caller copies it before drawing it.
 */
export function polygonGeometry(
  polygon: Polygon,
  on: Territory | undefined
): BufferGeometry {
  const kept = on ? drapedPolygons : flatPolygons;
  let geometry = kept.get(polygon);
  if (!geometry) {
    geometry = buildPolygonGeometry(polygon, on);
    kept.set(polygon, geometry);
  }
  return geometry;
}

function buildPolygonGeometry(
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
