import {
  BufferAttribute,
  type BufferGeometry,
  Path,
  Shape,
  ShapeGeometry,
  Vector2,
} from "three";
import { TessellateModifier } from "three/addons/modifiers/TessellateModifier.js";
import { mergeVertices } from "three/addons/utils/BufferGeometryUtils.js";
import type { Polygon, Territory } from "../types";
import { paperThickness } from "./paper-material";
import { baseTerrainField, type TerrainField } from "./terrain-field";
import { sampleTerrainSurface, type TerrainSurface } from "./terrain-surface";

export function terrainHeight(p: Territory, x: number, y: number): number {
  return paperThickness + baseTerrainField(p).sample(x, y).elevation;
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
  const triangles = new TessellateModifier(1.5, 18).modify(base);
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
  reshapeTerrain(geometry, p, baseTerrainField(p));
  return geometry;
}

/** Shared by the relief mesh and its ink, including optional excavated craters. */
export function reshapeTerrain(
  geometry: BufferGeometry,
  p: Territory,
  field: TerrainField
) {
  const surface = sampleTerrainSurface(
    new Float32Array(geometry.getAttribute("position").array),
    p,
    field,
    paperThickness
  );
  applyTerrainSurface(geometry, surface);
}

export function applyTerrainSurface(
  geometry: BufferGeometry,
  surface: TerrainSurface
) {
  const positions = geometry.getAttribute("position");
  positions.array.set(surface.positions);
  positions.needsUpdate = true;
  geometry.setAttribute("normal", new BufferAttribute(surface.normals, 3));
  geometry.setAttribute("occlusion", new BufferAttribute(surface.occlusion, 1));
  geometry.setAttribute("mineral", new BufferAttribute(surface.mineral, 1));
  geometry.computeBoundingSphere();
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
