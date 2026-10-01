import {
  BufferAttribute,
  type BufferGeometry,
  Path,
  Shape,
  ShapeGeometry,
  Vector2,
  Vector3,
} from "three";
import { TessellateModifier } from "three/addons/modifiers/TessellateModifier.js";
import { mergeVertices } from "three/addons/utils/BufferGeometryUtils.js";
import type { Polygon, Territory } from "../types";
import { paperThickness } from "./paper-material";

export function terrainHeight(p: Territory, x: number, y: number): number {
  let distance = Number.POSITIVE_INFINITY;
  for (const polygon of p.coast) {
    for (const ring of polygon) {
      for (let i = 1; i < ring.length; i += 1) {
        const a = ring[i - 1];
        const b = ring[i];
        if (!(a && b)) {
          continue;
        }
        const dx = b[0] - a[0],
          dy = b[1] - a[1];
        const t = Math.max(
          0,
          Math.min(
            1,
            ((x - a[0]) * dx + (y - a[1]) * dy) / (dx * dx + dy * dy || 1)
          )
        );
        distance = Math.min(
          distance,
          Math.hypot(x - a[0] - t * dx, y - a[1] - t * dy)
        );
      }
    }
  }
  const shore = Math.min(1, distance / 28);
  const taper = shore * shore * (3 - 2 * shore);
  const density = p.files.reduce(
    (sum, f) =>
      sum + Math.exp(-((x - f.x) ** 2 + (y - f.y) ** 2) / (2 * 22 ** 2)),
    0
  );
  return paperThickness + 18 * (1 - Math.exp(-density / 40)) * taper;
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
  const normals = new Float32Array(positions.count * 3);
  const occlusion = new Float32Array(positions.count);
  for (let i = 0; i < positions.count; i += 1) {
    const x = positions.getX(i),
      y = positions.getY(i);
    positions.setXYZ(i, p.x + x, -p.y + y, terrainHeight(p, x, -y));
    uv.setXY(i, (p.x + x) / width + 0.5, (-p.y + y) / height + 0.5);
    const elevation = positions.getZ(i);
    const east = terrainHeight(p, x + 3, -y);
    const west = terrainHeight(p, x - 3, -y);
    const south = terrainHeight(p, x, -y + 3);
    const north = terrainHeight(p, x, -y - 3);
    const dx = (east - west) / 6;
    const dy = (south - north) / 6;
    // Fixed-radius curvature avoids the long skinny triangles of a coast mesh
    // imprinting their tessellation on the paper.
    occlusion[i] = Math.max(
      0,
      Math.min(1, ((east + west + south + north) / 4 - elevation) * 2)
    );
    new Vector3(-dx, dy, 1).normalize().toArray(normals, i * 3);
  }
  geometry.setAttribute("normal", new BufferAttribute(normals, 3));
  geometry.setAttribute("occlusion", new BufferAttribute(occlusion, 1));
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
