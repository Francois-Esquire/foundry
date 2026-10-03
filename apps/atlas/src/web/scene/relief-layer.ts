import {
  BufferAttribute,
  BufferGeometry,
  Group,
  type Material,
  Mesh,
  type Texture,
  Vector2,
  type Vector3,
} from "three";
import { positionWorld, texture, uniform, vec2 } from "three/tsl";
import { MeshBasicNodeMaterial } from "three/webgpu";
import type { BelongingLayer } from "../belonging";
import type { Landmark } from "../landmarks";
import type { AtlasData, Territory } from "../types";
import type { InkView } from "./exploration";
import { paperThickness } from "./paper-material";
import type { PreparedRelief } from "./prepare-relief";
import { sampleReliefInk } from "./relief-ink";
import { prepareReliefTask } from "./relief-task";
import { applyTerrainSurface, terrainGeometry } from "./terrain";
import {
  baseTerrainField,
  createTerrainField,
  type TerrainField,
} from "./terrain-field";
import { createTerrainPicker } from "./terrain-picking";
import { landContours } from "./topography";

interface ReliefState extends PreparedRelief {
  field: TerrainField;
  pick: ReturnType<typeof createTerrainPicker>;
}

interface ReliefEntry {
  base: ReliefState;
  cached?: { key: string; state: ReliefState };
  current: ReliefState;
  geometry: BufferGeometry[];
  territory: Territory;
}

function applySurfaces(entry: ReliefEntry, state: PreparedRelief) {
  for (const [index, geometry] of entry.geometry.entries()) {
    const surface = state.surfaces[index];
    if (surface) {
      applyTerrainSurface(geometry, surface);
    }
  }
}

async function prepareState(
  entry: ReliefEntry,
  landmarks: readonly Landmark[],
  key: string,
  signal: AbortSignal,
  tilt: number
) {
  if (entry.cached?.key === key) {
    return entry.cached.state;
  }
  const prepared = await prepareReliefTask(
    {
      landmarks,
      positions: entry.base.surfaces.map((surface) => surface.positions),
      territory: entry.territory,
      thickness: paperThickness,
    },
    signal
  );
  if (!prepared || signal.aborted) {
    return;
  }
  const picking = entry.geometry.map((geometry, index) => {
    const shape = new BufferGeometry();
    const positions = prepared.surfaces[index]?.positions ?? new Float32Array();
    shape.setAttribute("position", new BufferAttribute(positions, 3));
    shape.setIndex(geometry.getIndex());
    return shape;
  });
  const state = {
    ...prepared,
    field: createTerrainField(entry.territory, landmarks),
    pick: createTerrainPicker(picking, tilt),
  };
  entry.cached = { key, state };
  return state;
}

function evidenceKey(id: string, landmarks: readonly Landmark[]) {
  return JSON.stringify([
    id,
    landmarks.map((mark) => [
      mark.file.id,
      mark.role !== "change",
      mark.change?.file.commits,
      mark.change ? mark.file.x : undefined,
      mark.change ? mark.file.y : undefined,
    ]),
  ]);
}

/** Terrain and cartographic ink share vertices, projection, and pointer geometry. */
export function createReliefLayer(
  data: AtlasData,
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
  const entries: ReliefEntry[] = data.territories.map((territory) => {
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
    const field = baseTerrainField(territory);
    const base: ReliefState = {
      contours: landContours(territory, field),
      field,
      pick: createTerrainPicker(geometry, tilt),
      strokes: sampleReliefInk(territory, field).strokes,
      surfaces: geometry.map((shape) => ({
        mineral: new Float32Array(shape.getAttribute("mineral").array),
        normals: new Float32Array(shape.getAttribute("normal").array),
        occlusion: new Float32Array(shape.getAttribute("occlusion").array),
        positions: new Float32Array(shape.getAttribute("position").array),
      })),
    };
    return {
      base,
      current: base,
      geometry,
      territory,
    };
  });
  group.add(surfaces);
  const fields = new Map<string, TerrainField>();
  const fieldFor = (territory: Territory) =>
    fields.get(territory.id) ?? baseTerrainField(territory);
  let requested = "";
  let applied: string | undefined;
  let controller = new AbortController();
  const apply = (entry: (typeof entries)[number], state: ReliefState) => {
    applySurfaces(entry, state);
    entry.current = state;
    fields.set(entry.territory.id, state.field);
  };
  return {
    contours: () => entries.flatMap((entry) => entry.current.contours),
    dispose() {
      controller.abort();
      for (const entry of entries) {
        for (const geometry of entry.geometry) {
          geometry.dispose();
        }
      }
      ink.dispose();
    },
    fieldFor,
    group,
    pick(point: Vector3) {
      let closest: Vector3 | undefined;
      for (const entry of entries) {
        const hit = entry.current.pick(point);
        if (hit && (!closest || hit.z > closest.z)) {
          closest = hit;
        }
      }
      return closest;
    },
    reliefInk: () =>
      entries.map((entry) => ({
        strokes: entry.current.strokes,
        territory: entry.territory,
      })),
    async setFeatures(belonging: BelongingLayer | null) {
      const landmarks = belonging?.features?.landmarks;
      const entry =
        landmarks && belonging
          ? entries.find(
              (candidate) => candidate.territory.id === belonging.territory.id
            )
          : undefined;
      const key =
        entry && landmarks ? evidenceKey(entry.territory.id, landmarks) : "";
      if (requested === key) {
        return false;
      }
      requested = key;
      controller.abort();
      controller = new AbortController();
      const { signal } = controller;
      const state =
        entry && landmarks
          ? await prepareState(entry, landmarks, key, signal, tilt)
          : undefined;
      if (signal.aborted) {
        return false;
      }
      const previous = entries.find(
        (candidate) => candidate.territory.id === applied
      );
      if (previous && previous !== entry) {
        apply(previous, previous.base);
      }
      if (entry && state) {
        apply(entry, state);
      }
      applied = entry?.territory.id;
      return true;
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
