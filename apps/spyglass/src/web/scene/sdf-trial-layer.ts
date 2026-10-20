import {
  BufferAttribute,
  BufferGeometry,
  Color,
  Group,
  Mesh,
  PlaneGeometry,
} from "three";
import type { SdfMeshMethod } from "../../lib/visualization/sdf-mesh";
import type { SpyglassData } from "../data/types";
import { chartWorld } from "../layout/chart-world";
import { islandPigment } from "../layout/island-pigment";
import {
  buildSdfTrial,
  defaultSdfTrialSettings,
  type SdfTrial,
  type SdfTrialSettings,
  type TrialMesh,
} from "../layout/sdf-trial";
import { isSceneLayerVisible } from "../settings/scene-composition";
import type { SceneLayer } from "./handle";
import { screenTerrainInputs } from "./screen-terrain-bake";
import {
  sdfTerrainMaterial,
  sdfWaterMaterial,
  sdfWaterUniforms,
} from "./sdf-trial-material";

/**
 * The SDF trial: a developer's layer, hidden in every preset, that stands
 * two islands of the geology preview up as meshes built from true signed
 * distances, over a seabed patch meshed as a height field, under a
 * translucent water sheet that reads the frame's depth. It stands in for
 * the geology preview over those two islands only, so show one or the
 * other. Nothing is built until the composition first shows it.
 */

/** A trial mesh as indexed geometry with its baked light. */
function geometryOf(mesh: TrialMesh): BufferGeometry {
  const geometry = new BufferGeometry();
  geometry.setIndex(new BufferAttribute(mesh.indices, 1));
  geometry.setAttribute("position", new BufferAttribute(mesh.positions, 3));
  geometry.setAttribute("normal", new BufferAttribute(mesh.normals, 3));
  geometry.setAttribute("shade", new BufferAttribute(mesh.shade, 3));
  geometry.computeBoundingSphere();
  return geometry;
}

/** The scene objects of a built trial. */
function trialObjects(
  trial: SdfTrial,
  data: SpyglassData,
  water: ReturnType<typeof sdfWaterUniforms>
) {
  const group = new Group();
  // The screen terrain's inputs hold the macro field the plates are cut from.
  const chart = chartWorld(data);
  const inputs = screenTerrainInputs(chart);
  const disposers: (() => void)[] = [() => inputs.dispose()];
  const plates = { grid: chart.world, macro: inputs.textures.macro };
  for (const island of trial.islands) {
    const territory = data.territories.find((each) => each.id === island.id);
    const terrain = sdfTerrainMaterial({
      pigment: new Color(islandPigment(territory ?? { id: island.id })),
      plates,
    });
    disposers.push(() => terrain.dispose());
    for (const mesh of [...island.chunks, island.patch]) {
      const geometry = geometryOf(mesh);
      disposers.push(() => geometry.dispose());
      group.add(new Mesh(geometry, terrain));
    }
    const { extent } = island;
    const sheet = new PlaneGeometry(
      extent.right - extent.left,
      extent.top - extent.bottom
    );
    sheet.translate(
      (extent.left + extent.right) / 2,
      (extent.top + extent.bottom) / 2,
      0
    );
    const waterMaterial = sdfWaterMaterial({ uniforms: water });
    disposers.push(() => {
      sheet.dispose();
      waterMaterial.dispose();
    });
    const surface = new Mesh(sheet, waterMaterial.material);
    // Drawn after the terrain, which it reads from the frame.
    surface.renderOrder = 10;
    group.add(surface);
  }
  return {
    dispose() {
      for (const dispose of disposers) {
        dispose();
      }
    },
    group,
  };
}

/** Counts and times a built trial reports, for the composition and the developer's hook. */
function trialStats(trial: SdfTrial): Record<string, number> {
  const stats: Record<string, number> = {
    buildMs: trial.timings.totalMs,
    chartMs: trial.timings.chartMs,
  };
  for (const [index, island] of trial.islands.entries()) {
    const prefix = `island${index}`;
    stats[`${prefix}Triangles`] = island.mesh.triangles;
    stats[`${prefix}Vertices`] = island.mesh.vertices;
    stats[`${prefix}Chunks`] = island.chunks.length;
    stats[`${prefix}PatchTriangles`] = island.patch.indices.length / 3;
    stats[`${prefix}FieldsMs`] = island.timings.fieldsMs;
    stats[`${prefix}SlabsMs`] = island.timings.slabsMs;
    stats[`${prefix}MeshMs`] = island.timings.meshMs;
    stats[`${prefix}PatchMs`] = island.timings.patchMs;
    stats[`${prefix}LightMs`] = island.timings.lightMs;
  }
  return stats;
}

export function createSdfTrialLayer(options: {
  data: SpyglassData;
  settings?: SdfTrialSettings;
}): SceneLayer & {
  /** The developer's controls: the mesher, the built trial and its islands. */
  developer: {
    islands: () => { extent: object; id: string; archetype: string }[];
    method: () => SdfMeshMethod;
    setMethod: (method: SdfMeshMethod) => void;
    stats: () => Record<string, number>;
  };
} {
  const { data } = options;
  let settings = options.settings ?? defaultSdfTrialSettings;
  const group = new Group();
  const water = sdfWaterUniforms();
  let trial: SdfTrial | undefined;
  let objects: ReturnType<typeof trialObjects> | undefined;
  const build = () => {
    if (!trial) {
      trial = buildSdfTrial(data, settings);
      objects = trialObjects(trial, data, water);
      group.add(objects.group);
    }
    return trial;
  };
  const clear = () => {
    if (objects) {
      group.remove(objects.group);
      objects.dispose();
    }
    objects = undefined;
    trial = undefined;
  };
  return {
    developer: {
      islands: () =>
        (trial?.islands ?? []).map((island) => ({
          archetype: island.archetype,
          extent: island.extent,
          id: island.id,
        })),
      method: () => settings.method,
      setMethod(method) {
        if (method !== settings.method) {
          settings = { ...settings, method };
          clear();
        }
      },
      stats: () => (trial ? trialStats(trial) : {}),
    },
    dispose: clear,
    group,
    id: "sdf-trial",
    kind: "layer",
    stats: () => (trial ? trialStats(trial) : {}),
    update(view, state, time) {
      if (!isSceneLayerVisible(state.settings.composition, "sdf-trial")) {
        return;
      }
      build();
      water.write(view, time);
    },
  };
}
