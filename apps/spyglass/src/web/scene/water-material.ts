import {
  DataTexture,
  DataUtils,
  HalfFloatType,
  LinearFilter,
  MathUtils,
  RedFormat,
} from "three";
import {
  cameraViewMatrix,
  color,
  exp,
  float,
  mix,
  positionWorld,
  texture as sampleTexture,
  smoothstep,
  uniform,
  uv,
  vec2,
  vec3,
} from "three/tsl";
import { MeshStandardNodeMaterial } from "three/webgpu";
import type { StructuralTerrain } from "../../lib/visualization/terrain";
import type { SpyglassData } from "../data/types";
import { grounds } from "../ladder/ink-ladder";
import type { OceanField, RimField } from "../layout/ocean-field";
import { shadeLevels, shallowsBand } from "../layout/ocean-shade";
import {
  isSceneLayerVisible,
  type SceneComposition,
} from "../settings/scene-composition";
import type { TerrainInspection } from "../settings/terrain-inspection";
import { paperSurface } from "./paper-surface";
import { createTerrainTexture } from "./terrain-texture";
import type { WeatherNodes } from "./weather";

/** Cells along the wreck mask's longer side. */
const wreckMaskResolution = 256;
/** The mask is full this close to a wreck, in map units, and gone this far. */
const wreckMaskFull = 18;
const wreckMaskGone = 40;

/**
 * Where wrecks lie: 1 within 18 map units of a wreck, falling to 0 at 40, on
 * a grid over the sea. The sea thins there so a wreck shows through.
 */
function wreckMask(data: SpyglassData): DataTexture {
  const scale = wreckMaskResolution / Math.max(data.width, data.height);
  const width = Math.max(1, Math.round(data.width * scale));
  const height = Math.max(1, Math.round(data.height * scale));
  const wrecks = data.formerPackages ?? [];
  const fade = wreckMaskGone - wreckMaskFull;
  const pixels = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const mapX = ((x + 0.5) / width - 0.5) * data.width;
      const mapY = ((y + 0.5) / height - 0.5) * data.height;
      let depth = 0;
      for (const wreck of wrecks) {
        const away = Math.hypot(mapX - wreck.x, mapY - wreck.y);
        depth = Math.max(depth, Math.min(1, (wreckMaskGone - away) / fade));
      }
      pixels[((height - 1 - y) * width + x) * 4] = Math.round(depth * 255);
    }
  }
  const mask = new DataTexture(pixels, width, height);
  mask.magFilter = LinearFilter;
  mask.minFilter = mask.magFilter;
  mask.needsUpdate = true;
  return mask;
}

/**
 * A field's cells as half-float texels, filtered so a cell magnifies as a
 * soft change. The field's first row is the chart's top; a texture's is its
 * bottom, so the rows are turned over on the way.
 */
function fieldTexture(
  field: Pick<OceanField, "height" | "width">,
  values: Float32Array
): DataTexture {
  const { width, height } = field;
  const texels = new Uint16Array(values.length);
  for (let row = 0; row < height; row += 1) {
    const from = row * width;
    const to = (height - 1 - row) * width;
    for (let i = 0; i < width; i += 1) {
      texels[to + i] = DataUtils.toHalfFloat(values[from + i] ?? 0);
    }
  }
  const texture = new DataTexture(
    texels,
    width,
    height,
    RedFormat,
    HalfFloatType
  );
  texture.magFilter = LinearFilter;
  texture.minFilter = LinearFilter;
  texture.needsUpdate = true;
  return texture;
}

/** The open sea's level beyond the terrain's silhouette, over the sea's extent. */
function shadeTexture(shade: OceanField): DataTexture {
  return fieldTexture(shade, shadeLevels(shade));
}

/**
 * Distance beyond the terrain's silhouette in map units, over the surf's
 * extent: the shade texture carries the open level this steps, not the
 * distance itself, and on a grid too coarse for the band, so the surf has a
 * texture of its own.
 */
function rimTexture(rim: RimField): DataTexture {
  return fieldTexture(
    rim,
    Float32Array.from(rim.outside, (cells) => cells / rim.scale)
  );
}

/** Distance off the nearest coast in map units, over the chart. */
function shoreTexture(shore: OceanField): DataTexture {
  return fieldTexture(
    shore,
    Float32Array.from(shore.distances, (cells) => cells / shore.scale)
  );
}

/** Low and high ends of the inspection ramp: a field reads dark to light. */
const inspectionRamp = { high: "#f4ead2", low: "#17324a", middle: "#5d8f8a" };

/**
 * The chart's sea, shaded in the material from the structural terrain: the
 * shore's shade deepening to deep water by the water's depth over the
 * terrain, its slopes lit from the northwest, deep water to ocean blue by
 * the open level beyond the terrain's silhouette, the shallows a soft band
 * off every coast, and the surf breaking just outside the silhouette.
 * Surface motion and drift read the shared weather clock, independently of
 * the camera. The shared paper surface is thinned over wrecks as the camera
 * comes in. An inspection replaces the water with one structural field.
 */
export function createWaterMaterial(options: {
  /** The chart's extent, which the shore field covers. */
  chart: Pick<SpyglassData, "height" | "width">;
  /** The silhouette's distance field, for the surf. */
  rim: RimField;
  /** The sea's extent, which the shade field covers and the material's plane fills. */
  sea: SpyglassData;
  shade: OceanField;
  shore: OceanField;
  /** The chart's structural terrain, whose water depth the sea shows. */
  terrain: StructuralTerrain;
  /** The scene's weather, for rim surf and subsurface drift. */
  weather: WeatherNodes;
}) {
  const { chart, rim, sea, shade, shore, terrain, weather } = options;
  const wrecks = !!sea.formerPackages?.length;
  const mask = wrecks ? wreckMask(sea) : undefined;
  const wreckReveal = uniform(0.2);
  const foundationLight = uniform(1);
  const drawn = { depth: uniform(1), shallows: uniform(1) };
  const terrainTexture = createTerrainTexture(terrain);
  // The terrain grid is centred on the chart, as the shore field is, and
  // clamps beyond its edge to the abyss it already reaches there.
  const terrainSample = sampleTexture(
    terrainTexture.texture,
    positionWorld.xy
      .div(vec2(terrainTexture.extent.width, terrainTexture.extent.height))
      .add(0.5)
  );
  const waterDepth = terrainSample.r;
  const terrainSlope = terrainSample.g;
  const inspection = terrainSample.b;
  const inspecting = terrainSample.a;
  const levels = shadeTexture(shade);
  const rims = rimTexture(rim);
  const distances = shoreTexture(shore);
  const material = new MeshStandardNodeMaterial({
    depthWrite: !wrecks,
    metalness: 0,
    roughness: 0.96,
    transparent: wrecks,
  });
  // The plane's uv spans the sea; the chart's own extent is cut from the
  // same point. Beyond the chart the shore texture clamps to its edge,
  // where every coast is far enough that the band is already nothing.
  const chartPoint = positionWorld.xy
    .div(vec2(chart.width, chart.height))
    .add(0.5);
  const openSea = sampleTexture(levels, uv()).r;
  const depths = mix(
    color(grounds.shoreWater),
    color(grounds.deepWater),
    waterDepth
  );
  const offshore = mix(
    color(grounds.openWater),
    mix(depths, color(grounds.openWater), openSea),
    drawn.depth
  );
  const { softness, width } = shallowsBand;
  const shallow = float(1).sub(
    smoothstep(
      width - softness,
      width + softness,
      sampleTexture(distances, chartPoint).r
    )
  );
  // Keep the coast luminous regardless of foundation visibility or overlap.
  const coastalGlow = exp(
    sampleTexture(distances, chartPoint).r.mul(-1 / 15)
  ).mul(0.35);
  // The depth already colours the water; the slope only lights and shades
  // it. Screen lifts faces turned to the northwest light; multiply shades
  // those turned away. A flat seabed is exactly the depth's own colour.
  const lipLight = terrainSlope.clamp(0, 1).mul(0.24);
  const dropShade = terrainSlope.negate().clamp(0, 1).mul(0.26);
  const screened = float(1).sub(
    float(1).sub(offshore).mul(float(1).sub(lipLight))
  );
  const relief = screened.mul(float(1).sub(dropShade));
  const ramp = mix(
    mix(
      color(inspectionRamp.low),
      color(inspectionRamp.middle),
      inspection.mul(2).clamp(0, 1)
    ),
    color(inspectionRamp.high),
    inspection.mul(2).sub(1).clamp(0, 1)
  );
  // The surf's extent is cut from the same point as the chart's; beyond it
  // the rim texture clamps to an edge every rim is farther from than the
  // band reaches.
  const rimPoint = positionWorld.xy
    .div(vec2(rim.extent.width, rim.extent.height))
    .add(0.5);
  const surf = weather.rimSurf(
    sampleTexture(rims, rimPoint).r,
    positionWorld.xy
  );
  const water = mix(
    mix(
      relief,
      color(grounds.shallows),
      shallow.max(coastalGlow).mul(drawn.shallows)
    ),
    color(grounds.surf),
    surf
  );
  // Drift light plays over raised seabed, where the water is shallow.
  const raised = float(1).sub(waterDepth).clamp(0, 1).mul(foundationLight);
  material.colorNode = paperSurface(mix(water, ramp, inspecting), {
    driftLight: (point) => mix(float(1), weather.driftLight(point), raised),
  });
  // Let the uneven crests read without overpowering the chart's ink.
  const normal = mix(
    vec3(0, 0, 1),
    weather.surfaceNormal(positionWorld.xy),
    0.45
  ).normalize();
  material.normalNode = normal.transformDirection(cameraViewMatrix);
  if (mask) {
    material.opacityNode = float(1).sub(
      sampleTexture(mask, uv()).r.mul(0.75).mul(wreckReveal)
    );
  }
  return {
    configure(
      composition: SceneComposition,
      focus = "",
      terrainInspection: TerrainInspection = ""
    ) {
      const foundations = isSceneLayerVisible(
        composition,
        "dependency-foundations"
      );
      foundationLight.value = foundations ? 1 : 0;
      terrainTexture.show({
        focus,
        foundations,
        inspection: terrainInspection,
      });
      drawn.depth.value = isSceneLayerVisible(composition, "ocean-depth")
        ? 1
        : 0;
      drawn.shallows.value = isSceneLayerVisible(composition, "ocean-shallows")
        ? 1
        : 0;
    },
    dispose() {
      material.dispose();
      levels.dispose();
      terrainTexture.texture.dispose();
      foundationLight.dispose();
      rims.dispose();
      distances.dispose();
      mask?.dispose();
      drawn.depth.dispose();
      drawn.shallows.dispose();
      wreckReveal.dispose();
    },
    drawn,
    material,
    setWreckReveal(pixelsPerUnit: number, visible = true) {
      wreckReveal.value = visible
        ? MathUtils.clamp((pixelsPerUnit - 0.5) / 2, 0.12, 1)
        : 0;
    },
  };
}
