import {
  BufferAttribute,
  BufferGeometry,
  Color,
  Group,
  Mesh,
  PlaneGeometry,
  Vector3,
} from "three";
import {
  attribute,
  cameraViewMatrix,
  color,
  float,
  fwidth,
  max,
  mix,
  normalLocal,
  positionWorld,
  smoothstep,
  uniform,
  vec3,
} from "three/tsl";
import {
  MeshBasicNodeMaterial,
  MeshStandardNodeMaterial,
  type Node,
} from "three/webgpu";
import {
  contourChannelLayout,
  contourChannels,
  contourLevels,
  defaultContourSettings,
} from "../../lib/visualization/contours";
import {
  depthBand,
  depthBands,
  elevationAtDepth,
  geologyLevels,
  landformArchetypes,
  nominalDepth,
  sampleGrid,
} from "../../lib/visualization/geology";
import type { SpyglassData } from "../data/types";
import { inks, materials as lit } from "../ladder/ink-ladder";
import { type ChartWorld, chartWorld } from "../layout/chart-world";
import { type GeologyLattice, geologyLattice } from "../layout/geology-lattice";
import { islandPigment } from "../layout/island-pigment";
import { isSceneLayerVisible } from "../settings/scene-composition";
import {
  isGeologyInspection,
  type TerrainInspection,
} from "../settings/terrain-inspection";
import { contourInkNode } from "./contour-lines";
import type { SceneLayer } from "./handle";
import { inspectionRamp } from "./water-material";
import { waterOpticsNode } from "./water-optics";
import type { WeatherNodes } from "./weather";

/**
 * The geology preview: the world terrain as one displaced mesh, seabed and
 * land together, under one nearly invisible water surface. The mesh is
 * shaded as the water shows it: the seabed is lit, then seen through its
 * own column of water by the optics, so the water's colour is composited in
 * the terrain's material and the surface above it only catches the light.
 * Every tunable is here; the preview builds once per layout, the first
 * time it is shown.
 */
export const defaultGeologyPreviewSettings = {
  /** Contour lines' peak darkening, 0 to 1, before the water fades them. */
  contours: 0.7,
  /**
   * Map units of height per elevation unit. At 14 a terrace riser, at
   * least 4 map units wide and a third of full land high, rises some 4.7
   * map units, steeper than 50° at its middle, so escarpments read as walls
   * in the tilted view; full land stands 14 units over its coast, the open
   * abyss 14 units under it, and a trench floor 17.5.
   */
  exaggeration: 14,
  land: {
    /** The pale sand ring at the waterline: elevation where it gives way to pigment. */
    beach: { colour: "#f1ead8", from: 0.025, to: 0.05 },
    /** Escarpments a share of the way to bare earth, by slope in elevation per map unit. */
    escarpment: {
      colour: lit.cliffEarth,
      share: 0.3,
      slope: { from: 0.03, to: 0.12 },
    },
    /** How much lighter the summit is than the shore, as a share of the pigment. */
    summitLift: 0.08,
  },
  lattice: {
    /** Coarse cells around any land within which the lattice is refined. */
    margin: 3,
    /** Fine quads along a coarse cell's side near land: a 1-unit lattice on a 4-unit grid. */
    refine: 4,
    /** Elevation units every vertex keeps from the water level. */
    waterGap: 0.003,
  },
  seabed: {
    /** Bare rock where the seabed is steep, below `rockBelow` metres. */
    rock: "#5e5850",
    rockBelow: { from: 20, to: 200 },
    /** The shallows' pale coral sand: the optics' own calibration seabed. */
    sand: "#f1ead8",
    /** Darker sediment on the deep floor, between these nominal depths. */
    sediment: "#8c8575",
    sedimentDepth: { from: 50, to: 1000 },
    /** Slope, elevation per map unit, from which the seabed turns to rock. */
    steep: { from: 0.008, share: 0.6, to: 0.04 },
  },
  /** A nearly invisible glossy surface over the water, catching the sun. */
  surface: {
    colour: "#dfeefa",
    /** How much of the weather's wave normal the surface takes. */
    motion: 0.45,
    opacity: 0.06,
    roughness: 0.25,
  },
  /**
   * Stepped bathymetry: each contour level reads as the edge of a plate,
   * its upper side lifted and the riser below it shaded, both a share of
   * the seabed's light over `width` of a level's span. 0 turns either off.
   */
  terraces: { lip: 0.14, riser: 0.12, width: 0.2 },
};
export type GeologyPreviewSettings = typeof defaultGeologyPreviewSettings;

/**
 * The knots of `nominalDepth`: the depth bands' boundaries and the deepest
 * a feature carves. Between them depth is linear in elevation, so the
 * material reads nominal depth from its elevation as the chart does.
 */
export function depthKnots(): { depth: number; elevation: number }[] {
  const depths = [
    ...depthBands.map(({ from }) => from),
    nominalDepth(geologyLevels.trenchFloor),
  ];
  return depths.map((depth) => ({ depth, elevation: elevationAtDepth(depth) }));
}

/** `nominalDepth` as a node: one clamped span per pair of knots, summed. */
function depthNode(elevation: Node<"float">): Node<"float"> {
  const knots = depthKnots();
  let depth: Node<"float"> = float(0);
  for (let index = 1; index < knots.length; index += 1) {
    const upper = knots[index - 1];
    const lower = knots[index];
    if (upper && lower && upper.elevation > lower.elevation) {
      depth = depth.add(
        float(upper.elevation)
          .sub(elevation)
          .div(upper.elevation - lower.elevation)
          .clamp(0, 1)
          .mul(lower.depth - upper.depth)
      );
    }
  }
  return depth;
}

function smooth(from: number, to: number, value: number): number {
  const t = Math.min(1, Math.max(0, (value - from) / (to - from)));
  return t * t * (3 - 2 * t);
}

/**
 * Each vertex's albedo in linear light: on land its island's pigment, a
 * sand ring at the waterline, escarpments toward bare earth and summits a
 * little lighter; under water pale sand in the shallows, sediment on the
 * deep floor and rock where the deep seabed is steep.
 */
function albedos(
  lattice: GeologyLattice,
  data: Pick<SpyglassData, "territories">,
  settings: GeologyPreviewSettings
): Float32Array {
  const { land, seabed } = settings;
  const pigments = lattice.islandIds.map((id) => {
    const territory = data.territories.find((each) => each.id === id);
    return new Color(islandPigment(territory ?? { id }));
  });
  const beach = new Color(land.beach.colour);
  const earth = new Color(land.escarpment.colour);
  const sand = new Color(seabed.sand);
  const sediment = new Color(seabed.sediment);
  const rock = new Color(seabed.rock);
  const tone = new Color();
  const values = new Float32Array(lattice.count * 3);
  for (let id = 0; id < lattice.count; id += 1) {
    const elevation = lattice.elevation[id] ?? 0;
    const slope = Math.hypot(
      lattice.gradient[id * 2] ?? 0,
      lattice.gradient[id * 2 + 1] ?? 0
    );
    const pigment = pigments[lattice.owner[id] ?? -1];
    if (elevation > 0 && pigment) {
      tone
        .copy(pigment)
        .multiplyScalar(1 + land.summitLift * elevation)
        .lerp(
          earth,
          land.escarpment.share *
            smooth(land.escarpment.slope.from, land.escarpment.slope.to, slope)
        )
        .lerp(beach, 1 - smooth(land.beach.from, land.beach.to, elevation));
    } else {
      const depth = nominalDepth(elevation);
      tone
        .copy(sand)
        .lerp(
          sediment,
          smooth(seabed.sedimentDepth.from, seabed.sedimentDepth.to, depth)
        )
        .lerp(
          rock,
          seabed.steep.share *
            smooth(seabed.steep.from, seabed.steep.to, slope) *
            smooth(seabed.rockBelow.from, seabed.rockBelow.to, depth)
        );
    }
    values.set([tone.r, tone.g, tone.b], id * 3);
  }
  return values;
}

/**
 * Each vertex's contour channels, as `contourChannels` bakes a texture's:
 * the vertices read as a one-row field, and the mesh interpolates the
 * channels as a texture's filter would, so the lines follow the refined
 * land rather than the coarser grid.
 */
function contourAttribute(lattice: GeologyLattice): Float32Array {
  const stride = contourChannelLayout.length;
  const channels = contourChannels(
    {
      cell: 1,
      elevation: lattice.elevation,
      height: 1,
      left: 0,
      top: 0,
      width: lattice.count,
    },
    contourLevels()
  );
  const values = new Float32Array(lattice.count * 3);
  for (let id = 0; id < lattice.count; id += 1) {
    values.set(channels.subarray(id * stride, id * stride + 3), id * 3);
  }
  return values;
}

/** The lattice in world space: x right, y up the chart, z the exaggerated elevation, normals from the gradient. */
function terrainGeometry(
  lattice: GeologyLattice,
  albedo: Float32Array,
  exaggeration: number
): BufferGeometry {
  const positions = new Float32Array(lattice.count * 3);
  const normals = new Float32Array(lattice.count * 3);
  const normal = new Vector3();
  for (let id = 0; id < lattice.count; id += 1) {
    const elevation = lattice.elevation[id] ?? 0;
    positions.set(
      [
        lattice.points[id * 2] ?? 0,
        -(lattice.points[id * 2 + 1] ?? 0),
        elevation * exaggeration,
      ],
      id * 3
    );
    // World y is map y turned over, so the y slope changes sign.
    normal
      .set(
        -exaggeration * (lattice.gradient[id * 2] ?? 0),
        exaggeration * (lattice.gradient[id * 2 + 1] ?? 0),
        1
      )
      .normalize();
    normals.set([normal.x, normal.y, normal.z], id * 3);
  }
  const geometry = new BufferGeometry();
  geometry.setIndex(new BufferAttribute(lattice.index, 1));
  geometry.setAttribute("position", new BufferAttribute(positions, 3));
  geometry.setAttribute("normal", new BufferAttribute(normals, 3));
  geometry.setAttribute("elevation", new BufferAttribute(lattice.elevation, 1));
  geometry.setAttribute("albedo", new BufferAttribute(albedo, 3));
  geometry.setAttribute(
    "contour",
    new BufferAttribute(contourAttribute(lattice), 3)
  );
  geometry.setAttribute(
    "inspection",
    new BufferAttribute(new Float32Array(lattice.count), 1)
  );
  geometry.computeBoundingSphere();
  return geometry;
}

/** The scene's light as `createLitScene` balances it: level ground at 1. */
function sunlight(normal: Node<"vec3">): Node<"vec3"> {
  const sun = new Vector3(-600, 700, 700).normalize();
  const ambient = new Color(lit.light.ambient).multiplyScalar(1.23 / Math.PI);
  const direct = new Color(lit.light.sun).multiplyScalar(3.16 / Math.PI);
  const facing = normal
    .normalize()
    .dot(vec3(sun.x, sun.y, sun.z))
    .max(0);
  return vec3(ambient.r, ambient.g, ambient.b).add(
    vec3(direct.r, direct.g, direct.b).mul(facing)
  );
}

/**
 * The terrain's material: unlit, since it lights the seabed itself and the
 * water must not be shaded by the relief beneath it. The seabed's albedo is
 * lit by the scene's sun, stepped at each contour level under water, seen
 * through its column by the optics, inked with contours the water fades,
 * and replaced by an inspection's ramp while one is shown.
 */
function terrainMaterial(settings: GeologyPreviewSettings) {
  const elevation = attribute<"float">("elevation", "float");
  const albedo = attribute<"vec3">("albedo", "vec3");
  const contour = attribute<"vec3">("contour", "vec3");
  const inspection = attribute<"float">("inspection", "float");
  const inspecting = uniform(0);
  const underwater = float(1).sub(smoothstep(-0.001, 0, elevation));
  // Each level as a plate's edge: lit just above it, shaded just below.
  const { lip, riser, width } = settings.terraces;
  const step = contour.x.fract();
  const resolved = smoothstep(
    defaultContourSettings.lines.spacing.from,
    defaultContourSettings.lines.spacing.to,
    float(1).div(max(fwidth(contour.x), 1e-6))
  );
  const edge = float(1)
    .sub(smoothstep(0, width, step))
    .mul(lip)
    .sub(smoothstep(1 - width, 1, step).mul(riser));
  const plates = float(1).add(edge.mul(resolved).mul(underwater));
  const seabed = albedo.mul(sunlight(normalLocal)).mul(plates);
  const optics = waterOpticsNode({
    depth: depthNode(elevation),
    seabedColour: seabed,
  });
  const ink = contourInkNode({
    coordinate: contour.x,
    elevation,
    major: contour.y,
    visibility: contour.z,
  })
    .mul(optics.visibility)
    .mul(settings.contours);
  const inkColour = mix(
    color(inks.landContour),
    color(inks.seaContour),
    underwater
  );
  const water = mix(optics.colour, optics.colour.mul(inkColour), ink);
  const ramp = mix(
    mix(
      color(inspectionRamp.low),
      color(inspectionRamp.middle),
      inspection.mul(2).clamp(0, 1)
    ),
    color(inspectionRamp.high),
    inspection.mul(2).sub(1).clamp(0, 1)
  );
  const material = new MeshBasicNodeMaterial();
  material.colorNode = mix(water, ramp, inspecting);
  return {
    dispose() {
      material.dispose();
      optics.dispose();
      inspecting.dispose();
    },
    inspecting,
    material,
  };
}

/** The water's surface: a glossy sheet at the water level, nearly transparent, moving with the weather's waves. */
function surfaceSheet(
  extent: { height: number; width: number },
  weather: Pick<WeatherNodes, "surfaceNormal">,
  settings: GeologyPreviewSettings["surface"]
) {
  const material = new MeshStandardNodeMaterial({
    color: new Color(settings.colour),
    depthWrite: false,
    metalness: 0,
    opacity: settings.opacity,
    roughness: settings.roughness,
    transparent: true,
  });
  material.normalNode = mix(
    vec3(0, 0, 1),
    weather.surfaceNormal(positionWorld.xy),
    settings.motion
  )
    .normalize()
    .transformDirection(cameraViewMatrix);
  const geometry = new PlaneGeometry(extent.width, extent.height);
  return {
    dispose() {
      geometry.dispose();
      material.dispose();
    },
    mesh: new Mesh(geometry, material),
  };
}

/** Feature influence by world cell, 0 to 1: how far the seabed's features move it. */
function seafloorInfluence(chart: ChartWorld): Float32Array {
  const { world } = chart;
  const sum = new Float32Array(world.width * world.height);
  for (const feature of chart.seafloor.contributions) {
    for (let r = 0; r < feature.height; r += 1) {
      for (let c = 0; c < feature.width; c += 1) {
        const row = feature.row + r;
        const column = feature.column + c;
        if (
          row >= 0 &&
          column >= 0 &&
          row < world.height &&
          column < world.width
        ) {
          const at = row * world.width + column;
          sum[at] =
            (sum[at] ?? 0) +
            Math.abs(feature.values[r * feature.width + c] ?? 0);
        }
      }
    }
  }
  // A quarter of the elevation range reads as near full influence.
  return Float32Array.from(sum, (value) => 1 - Math.exp(-value / 0.25));
}

const bandOrder = depthBands.map(({ id }) => id);

/** One vertex's inspected value, 0 to 1, for a geology inspection; 0 for any other. */
function inspected(
  inspection: TerrainInspection,
  chart: ChartWorld,
  lattice: GeologyLattice,
  influence: () => Float32Array,
  id: number
): number {
  const elevation = lattice.elevation[id] ?? 0;
  switch (inspection) {
    case "world-elevation":
      return (
        (elevation - geologyLevels.trenchFloor) /
        (geologyLevels.land - geologyLevels.trenchFloor)
      );
    case "depth-band":
      // Land is light; each band darker to the trench at 0.
      return elevation >= 0
        ? 1
        : 1 -
            (bandOrder.indexOf(depthBand(nominalDepth(elevation))) + 1) /
              bandOrder.length;
    case "landform": {
      const island = lattice.islandIds[lattice.owner[id] ?? -1];
      const archetype = island
        ? chart.landforms.get(island)?.archetype
        : undefined;
      // Each formation its own grey, distinct from the sea's dark.
      return archetype
        ? 0.25 +
            (0.75 * landformArchetypes.indexOf(archetype)) /
              (landformArchetypes.length - 1)
        : 0;
    }
    case "seafloor":
      return sampleGrid(
        chart.world,
        influence(),
        lattice.points[id * 2] ?? 0,
        lattice.points[id * 2 + 1] ?? 0
      );
    default:
      return 0;
  }
}

/**
 * The preview built from the chart's layout: the world terrain, its
 * lattice, the terrain mesh and the water's surface, in one group. `extent`
 * is the sea's, which the lattice's outer ring and the surface reach to.
 */
export function buildGeologyPreview(options: {
  data: SpyglassData;
  extent: { height: number; width: number };
  settings?: GeologyPreviewSettings;
  weather: Pick<WeatherNodes, "surfaceNormal">;
}) {
  const {
    data,
    extent,
    settings = defaultGeologyPreviewSettings,
    weather,
  } = options;
  const chart = chartWorld(data);
  const lattice = geologyLattice({
    extent,
    islands: data.territories,
    landform: chart.landform,
    settings: settings.lattice,
    world: chart.world,
  });
  const geometry = terrainGeometry(
    lattice,
    albedos(lattice, data, settings),
    settings.exaggeration
  );
  const terrain = terrainMaterial(settings);
  const surface = surfaceSheet(extent, weather, settings.surface);
  const group = new Group();
  group.add(new Mesh(geometry, terrain.material), surface.mesh);
  let influence: Float32Array | undefined;
  let shown: TerrainInspection = "";
  return {
    chart,
    dispose() {
      geometry.dispose();
      terrain.dispose();
      surface.dispose();
    },
    geometry,
    group,
    /** Shows a geology inspection in place of the water, or the water for any other. */
    inspect(inspection: TerrainInspection) {
      const next = isGeologyInspection(inspection) ? inspection : "";
      if (next === shown) {
        return;
      }
      shown = next;
      terrain.inspecting.value = next ? 1 : 0;
      if (!next) {
        return;
      }
      const values = geometry.getAttribute("inspection");
      const lazyInfluence = () => {
        influence ??= seafloorInfluence(chart);
        return influence;
      };
      for (let id = 0; id < lattice.count; id += 1) {
        values.setX(id, inspected(next, chart, lattice, lazyInfluence, id));
      }
      values.needsUpdate = true;
    },
    lattice,
    material: terrain.material,
    surface: surface.mesh,
  };
}

export type GeologyPreview = ReturnType<typeof buildGeologyPreview>;

/**
 * The geology preview as a scene layer, hidden by default. Its group is
 * empty until the composition first shows it; then the preview is built,
 * once, and kept until the scene is disposed.
 */
export function createGeologyLayer(
  options: Omit<Parameters<typeof buildGeologyPreview>[0], "settings"> & {
    settings?: GeologyPreviewSettings;
  }
): SceneLayer & { preview: () => GeologyPreview } {
  const group = new Group();
  let built: GeologyPreview | undefined;
  const preview = () => {
    if (!built) {
      built = buildGeologyPreview(options);
      group.add(built.group);
    }
    return built;
  };
  return {
    dispose() {
      built?.dispose();
    },
    group,
    id: "geology",
    kind: "layer",
    preview,
    stats: (): Record<string, number> =>
      built
        ? {
            triangles: built.lattice.index.length / 3,
            vertices: built.lattice.count,
          }
        : {},
    update(_view, state) {
      if (!isSceneLayerVisible(state.settings.composition, "geology")) {
        return;
      }
      preview().inspect(state.settings.terrainInspection);
    },
  };
}
