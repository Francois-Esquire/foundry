import * as THREE from "three";
import { TessellateModifier } from "three/addons/modifiers/TessellateModifier.js";
import { mergeVertices } from "three/addons/utils/BufferGeometryUtils.js";
import { paperThickness } from "./paper-material";
import type { Polygon, Territory } from "./types";

export function terrainHeight(p: Territory, x: number, y: number): number {
  let distance = Number.POSITIVE_INFINITY;
  for (const polygon of p.coast) {
    for (const ring of polygon) {
      for (let i = 1; i < ring.length; i++) {
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
): THREE.BufferGeometry {
  const rings = polygon.map((ring) =>
    ring.map(([x, y]) => new THREE.Vector2(x, -y))
  );
  const shape = new THREE.Shape(rings[0]);
  for (const hole of rings.slice(1)) {
    shape.holes.push(new THREE.Path(hole));
  }
  const base = new THREE.ShapeGeometry(shape);
  const triangles = new TessellateModifier(5, 12).modify(base);
  base.dispose();
  triangles.deleteAttribute("normal");
  const geometry = mergeVertices(triangles);
  triangles.dispose();
  const positions = geometry.getAttribute("position");
  const uv = geometry.getAttribute("uv");
  const normals = new Float32Array(positions.count * 3);
  for (let i = 0; i < positions.count; i++) {
    const x = positions.getX(i),
      y = positions.getY(i);
    positions.setXYZ(i, p.x + x, -p.y + y, terrainHeight(p, x, -y));
    uv.setXY(i, (p.x + x) / width + 0.5, (-p.y + y) / height + 0.5);
    const dx =
      (terrainHeight(p, x + 0.2, -y) - terrainHeight(p, x - 0.2, -y)) / 0.4;
    const dy =
      (terrainHeight(p, x, -y + 0.2) - terrainHeight(p, x, -y - 0.2)) / 0.4;
    new THREE.Vector3(-dx, dy, 1).normalize().toArray(normals, i * 3);
  }
  geometry.setAttribute("normal", new THREE.BufferAttribute(normals, 3));
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
