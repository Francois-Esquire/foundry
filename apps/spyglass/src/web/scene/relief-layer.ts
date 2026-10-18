import {
  type BufferGeometry,
  Color,
  DoubleSide,
  Group,
  type Material,
  Mesh,
  type Texture,
  Vector2,
} from "three";
import { positionWorld, texture, uniform, vec2 } from "three/tsl";
import { MeshBasicNodeMaterial, MeshStandardNodeMaterial } from "three/webgpu";
import type { SpyglassData } from "../data/types";
import { grounds, materials } from "../ladder/ink-ladder";
import { baseTerrainField } from "../layout/terrain-field";
import type { InkView } from "../view/chart-view";
import { coastWallGeometry, terrainGeometry } from "./terrain";

const cliffEarth = new Color(materials.cliffEarth);

/**
 * Every island's relief: its terrain surface on the shared paper, carrying
 * its own pigment, its coast wall, and the ink canvas projected over it
 * until phase 5 draws the ink as marks. The terrain geometries are exposed
 * for the pointer's hit test, which picks against them.
 */
export function createReliefLayer(
  data: SpyglassData,
  paper: Material,
  map: Texture
) {
  const group = new Group();
  const surfaces = new Group();
  const center = uniform(new Vector2());
  const size = uniform(new Vector2(data.width, data.height));
  const coordinates = vec2(
    positionWorld.x.sub(center.x),
    positionWorld.y.add(center.y)
  )
    .div(size)
    .add(0.5);
  const sampled = texture(map, coordinates);
  const ink = new MeshBasicNodeMaterial({
    depthTest: false,
    depthWrite: false,
    transparent: true,
  });
  ink.colorNode = sampled.rgb;
  const inView = coordinates.x
    .greaterThanEqual(0)
    .and(coordinates.x.lessThanEqual(1))
    .and(coordinates.y.greaterThanEqual(0))
    .and(coordinates.y.lessThanEqual(1));
  ink.opacityNode = inView.select(sampled.a, 0);
  // Raised coasts: every island's low cliff is the land a shade deeper.
  const cliff = new MeshStandardNodeMaterial({
    color: new Color(grounds.land).lerp(cliffEarth, 0.22),
    metalness: 0,
    roughness: 0.95,
    side: DoubleSide,
  });
  const walls: BufferGeometry[] = [];
  const geometries = data.territories.flatMap((territory) =>
    territory.coast.map((polygon) => {
      const shape = terrainGeometry(territory, polygon);
      surfaces.add(new Mesh(shape, paper));
      const wall = coastWallGeometry(territory, polygon);
      walls.push(wall);
      surfaces.add(new Mesh(wall, cliff));
      const drawing = new Mesh(shape, ink);
      drawing.renderOrder = 2;
      group.add(drawing);
      return shape;
    })
  );
  group.add(surfaces);
  return {
    dispose() {
      for (const geometry of geometries) {
        geometry.dispose();
      }
      for (const wall of walls) {
        wall.dispose();
      }
      cliff.dispose();
      ink.dispose();
    },
    fieldFor: baseTerrainField,
    /** Every island's terrain surface, in chart space. */
    geometries,
    group,
    setMap(next: Texture) {
      sampled.value = next;
    },
    setView(view: InkView) {
      center.value.set(view.x, view.y);
      size.value.set(view.width, view.height);
    },
  };
}
