import {
  type BufferGeometry,
  Color,
  DoubleSide,
  Group,
  type Material,
  Mesh,
  type Texture,
  Vector2,
  type Vector3,
} from "three";
import { positionWorld, texture, uniform, vec2 } from "three/tsl";
import { MeshBasicNodeMaterial, MeshStandardNodeMaterial } from "three/webgpu";
import type { SpyglassData } from "../types";
import type { InkView } from "./exploration";
import { grounds, materials } from "./ink-ladder";
import { coastWallGeometry, terrainGeometry } from "./terrain";
import { baseTerrainField } from "./terrain-field";
import { createTerrainPicker } from "./terrain-picking";

const cliffEarth = new Color(materials.cliffEarth);

/** Terrain and cartographic ink share vertices, projection, and pointer geometry. */
export function createReliefLayer(
  data: SpyglassData,
  paper: Material,
  map: Texture,
  tilt: number
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
  const entries = data.territories.map((territory) => {
    const geometry = territory.coast.map((polygon) => {
      const shape = terrainGeometry(
        territory,
        polygon,
        data.width,
        data.height
      );
      surfaces.add(new Mesh(shape, paper));
      const wall = coastWallGeometry(territory, polygon);
      walls.push(wall);
      surfaces.add(new Mesh(wall, cliff));
      const drawing = new Mesh(shape, ink);
      drawing.renderOrder = 2;
      group.add(drawing);
      return shape;
    });
    return {
      geometry,
      pick: createTerrainPicker(geometry, tilt),
    };
  });
  group.add(surfaces);
  return {
    dispose() {
      for (const entry of entries) {
        for (const geometry of entry.geometry) {
          geometry.dispose();
        }
      }
      for (const wall of walls) {
        wall.dispose();
      }
      cliff.dispose();
      ink.dispose();
    },
    fieldFor: baseTerrainField,
    group,
    pick(point: Vector3) {
      let closest: Vector3 | undefined;
      for (const entry of entries) {
        const hit = entry.pick(point);
        if (hit && (!closest || hit.z > closest.z)) {
          closest = hit;
        }
      }
      return closest;
    },
    setMap(next: Texture) {
      sampled.value = next;
    },
    setView(view: InkView) {
      center.value.set(view.x, view.y);
      size.value.set(view.width, view.height);
    },
  };
}
