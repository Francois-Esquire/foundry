import { Group, type Material, Mesh, type Texture, Vector2 } from "three";
import { positionWorld, texture, uniform, vec2 } from "three/tsl";
import { MeshBasicNodeMaterial } from "three/webgpu";
import type { BelongingLayer } from "../belonging";
import type { Landmark } from "../landmarks";
import type { AtlasData, Territory } from "../types";
import type { InkView } from "./exploration";
import { reshapeTerrain, terrainGeometry } from "./terrain";
import {
  baseTerrainField,
  createTerrainField,
  type TerrainField,
} from "./terrain-field";

/** Terrain and cartographic ink share vertices, projection, and pointer geometry. */
export function createReliefLayer(
  data: AtlasData,
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
  const entries = data.territories.map((territory) => {
    const geometry = territory.coast.map((polygon) => {
      const shape = terrainGeometry(
        territory,
        polygon,
        data.width,
        data.height
      );
      surfaces.add(new Mesh(shape, paper));
      const drawing = new Mesh(shape, ink);
      drawing.renderOrder = 2;
      group.add(drawing);
      return shape;
    });
    return { geometry, territory };
  });
  group.add(surfaces);
  const fields = new Map<string, TerrainField>();
  const fieldFor = (territory: Territory) =>
    fields.get(territory.id) ?? baseTerrainField(territory);
  let active: { id: string; landmarks: Landmark[] } | undefined;
  return {
    dispose() {
      for (const entry of entries) {
        for (const geometry of entry.geometry) {
          geometry.dispose();
        }
      }
      ink.dispose();
    },
    fieldFor,
    group,
    setFeatures(belonging: BelongingLayer | null) {
      const landmarks = belonging?.features?.landmarks;
      const next =
        landmarks && belonging
          ? { id: belonging.territory.id, landmarks }
          : undefined;
      if (active?.id === next?.id && active?.landmarks === next?.landmarks) {
        return false;
      }
      const previous = active?.id;
      active = next;
      for (const entry of entries) {
        if (
          entry.territory.id !== previous &&
          entry.territory.id !== active?.id
        ) {
          continue;
        }
        const field =
          entry.territory.id === active?.id
            ? createTerrainField(entry.territory, active.landmarks)
            : baseTerrainField(entry.territory);
        fields.set(entry.territory.id, field);
        for (const geometry of entry.geometry) {
          reshapeTerrain(geometry, entry.territory, field);
        }
      }
      return true;
    },
    setMap(next: Texture) {
      sampled.value = next;
    },
    setView(view: InkView) {
      center.value.set(view.x, view.y);
      size.value.set(view.width, view.height);
    },
    surfaces,
  };
}
