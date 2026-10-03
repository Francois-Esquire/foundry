import {
  BufferAttribute,
  BufferGeometry,
  Path,
  Shape,
  ShapeGeometry,
  Vector2,
} from "three";
import { TessellateModifier } from "three/addons/modifiers/TessellateModifier.js";
import { mergeVertices } from "three/addons/utils/BufferGeometryUtils.js";
import { islandPlinth } from "../codex/bindings";
import type { Polygon, Territory } from "../types";
import { paperThickness } from "./paper-material";
import { baseTerrainField } from "./terrain-field";
import { sampleTerrainSurface } from "./terrain-surface";

/** The island's top surface: plinth plus usage relief above the paper. */
export const islandTop = paperThickness + islandPlinth;

export function terrainHeight(p: Territory, x: number, y: number): number {
  return islandTop + baseTerrainField(p).sample(x, y).elevation;
}

export function terrainGeometry(
  p: Territory,
  polygon: Polygon,
  width: number,
  height: number
): BufferGeometry {
  const rings = polygon.map((ring) => ring.map(([x, y]) => new Vector2(x, -y)));
  const shape = new Shape(rings[0]);
  for (const hole of rings.slice(1)) {
    shape.holes.push(new Path(hole));
  }
  const base = new ShapeGeometry(shape);
  const triangles = new TessellateModifier(3, 16).modify(base);
  base.dispose();
  triangles.deleteAttribute("normal");
  const geometry = mergeVertices(triangles);
  triangles.dispose();
  const positions = geometry.getAttribute("position");
  const uv = geometry.getAttribute("uv");
  for (let i = 0; i < positions.count; i += 1) {
    const x = positions.getX(i),
      y = positions.getY(i);
    positions.setXYZ(i, p.x + x, -p.y + y, 0);
    uv.setXY(i, (p.x + x) / width + 0.5, (-p.y + y) / height + 0.5);
  }
  const surface = sampleTerrainSurface(
    new Float32Array(positions.array),
    p,
    baseTerrainField(p),
    islandTop
  );
  positions.array.set(surface.positions);
  positions.needsUpdate = true;
  geometry.setAttribute("normal", new BufferAttribute(surface.normals, 3));
  geometry.setAttribute("occlusion", new BufferAttribute(surface.occlusion, 1));
  geometry.computeBoundingSphere();
  return geometry;
}

/** Low vertical lift from the sea to the plinth along every coast ring. */
export function coastWallGeometry(
  p: Territory,
  polygon: Polygon
): BufferGeometry {
  const positions: number[] = [];
  const normals: number[] = [];
  for (const [index, ring] of polygon.entries()) {
    const points = ring.map(([x, y]) => [p.x + x, -(p.y + y)] as const);
    let area = 0;
    for (const [i, [x, y]] of points.entries()) {
      const [nx, ny] = points[(i + 1) % points.length] ?? [x, y];
      area += x * ny - nx * y;
    }
    // Faces point away from land: out of the outer ring, into each lake hole.
    const side = (area > 0 ? 1 : -1) * (index === 0 ? 1 : -1);
    for (let i = 1; i < points.length; i += 1) {
      const a = points[i - 1];
      const b = points[i];
      if (!(a && b)) {
        continue;
      }
      const [ax, ay] = a;
      const [bx, by] = b;
      const length = Math.hypot(bx - ax, by - ay) || 1;
      const nx = (side * (by - ay)) / length;
      const ny = (side * (ax - bx)) / length;
      positions.push(
        ...[ax, ay, 0, bx, by, 0, bx, by, islandTop],
        ...[ax, ay, 0, bx, by, islandTop, ax, ay, islandTop]
      );
      for (let corner = 0; corner < 6; corner += 1) {
        normals.push(nx, ny, 0);
      }
    }
  }
  const geometry = new BufferGeometry();
  geometry.setAttribute(
    "position",
    new BufferAttribute(new Float32Array(positions), 3)
  );
  geometry.setAttribute(
    "normal",
    new BufferAttribute(new Float32Array(normals), 3)
  );
  return geometry;
}

export function settlementColor(kind: string): string {
  switch (kind) {
    case "test":
      return "#526f7b";
    case "story":
      return "#975b70";
    case "config":
      return "#896629";
    case "source":
      return "#665139";
    default:
      return "#8d8064";
  }
}
