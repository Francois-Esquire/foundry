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
import { grounds } from "../ladder/ink-ladder";
import type { Continent } from "../layout/continent";
import { continentHeight } from "../layout/continent";
import { pigmentAttribute } from "./terrain";

/**
 * Connecting land, a developer session's layer: one paper mesh per continent
 * outline, raised along `continentHeight` so it meets each island's coast,
 * in the continent's own ground colour. It carries no terrain concavity of
 * its own.
 */
export function createContinentGround(
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
      const positions = geometry.getAttribute("position");
      for (let i = 0; i < positions.count; i += 1) {
        positions.setZ(
          i,
          continentHeight(continent, positions.getX(i), -positions.getY(i))
        );
      }
      geometry.computeVertexNormals();
      geometry.setAttribute(
        "occlusion",
        new BufferAttribute(new Float32Array(positions.count), 1)
      );
      geometry.setAttribute(
        "pigment",
        pigmentAttribute(positions.count, grounds.continent)
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
