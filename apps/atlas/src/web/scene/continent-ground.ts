import {
  BufferAttribute,
  type BufferGeometry,
  Group,
  type Material,
  Mesh,
  Shape,
  ShapeGeometry,
  Vector2,
} from "three";
import { TessellateModifier } from "three/addons/modifiers/TessellateModifier.js";
import type { Continent } from "../continent";
import { continentHeight } from "../continent";
import type { AtlasData } from "../types";

/**
 * Connecting land, a developer session's layer: one paper mesh per continent
 * outline, raised along `continentHeight` so it meets each island's coast.
 * It carries no terrain concavity of its own.
 */
export function createContinentGround(
  data: AtlasData,
  continents: readonly Continent[],
  paper: Material
) {
  const group = new Group();
  const geometries: BufferGeometry[] = [];
  for (const continent of continents) {
    for (const ring of continent.field.outline) {
      const base = new ShapeGeometry(
        new Shape(ring.map(([x, y]) => new Vector2(x, -y)))
      );
      const geometry = new TessellateModifier(16, 12).modify(base);
      base.dispose();
      const positions = geometry.getAttribute("position"),
        uv = geometry.getAttribute("uv");
      for (let i = 0; i < positions.count; i += 1) {
        const x = positions.getX(i),
          y = positions.getY(i);
        positions.setZ(i, continentHeight(continent, x, -y));
        uv.setXY(i, x / data.width + 0.5, y / data.height + 0.5);
      }
      geometry.computeVertexNormals();
      geometry.setAttribute(
        "occlusion",
        new BufferAttribute(new Float32Array(positions.count), 1)
      );
      group.add(new Mesh(geometry, paper));
      geometries.push(geometry);
    }
  }
  return {
    dispose: () => {
      for (const geometry of geometries) {
        geometry.dispose();
      }
    },
    group,
  };
}
