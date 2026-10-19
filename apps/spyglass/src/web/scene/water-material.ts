import {
  DataTexture,
  DataUtils,
  HalfFloatType,
  LinearFilter,
  MathUtils,
  RedFormat,
  RGFormat,
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
import type { SpyglassData } from "../data/types";
import { grounds } from "../ladder/ink-ladder";
import type { OceanField, RimField } from "../layout/ocean-field";
import { shadeLevels, shallowsBand } from "../layout/ocean-shade";
import {
  isSceneLayerVisible,
  type SceneComposition,
} from "../settings/scene-composition";
import { createFoundationTexture } from "./foundation-material";
import { paperSurface } from "./paper-surface";
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
 * A field's cells as half-float texels, `channels` to a cell, filtered so a
 * cell magnifies as a soft change. The field's first row is the chart's top;
 * a texture's is its bottom, so the rows are turned over on the way.
 */
function fieldTexture(
  field: Pick<OceanField, "height" | "width">,
  values: Float32Array,
  channels: 1 | 2
): DataTexture {
  const { width, height } = field;
  const texels = new Uint16Array(values.length);
  const rowLength = width * channels;
  for (let row = 0; row < height; row += 1) {
    const from = row * rowLength;
    const to = (height - 1 - row) * rowLength;
    for (let i = 0; i < rowLength; i += 1) {
      texels[to + i] = DataUtils.toHalfFloat(values[from + i] ?? 0);
    }
  }
  const texture = new DataTexture(
    texels,
    width,
    height,
    channels === 1 ? RedFormat : RGFormat,
    HalfFloatType
  );
  texture.magFilter = LinearFilter;
  texture.minFilter = LinearFilter;
  texture.needsUpdate = true;
  return texture;
}

/** The sea's two shading levels, depth and open water, over the sea's extent. */
function shadeTexture(shade: OceanField): DataTexture {
  return fieldTexture(shade, shadeLevels(shade), 2);
}

/**
 * Distance beyond the nearest archipelago rim in map units, over the surf's
 * extent: the shade texture carries the open level this steps, not the
 * distance itself, and on a grid too coarse for the band, so the surf has a
 * texture of one channel of its own.
 */
function rimTexture(rim: RimField): DataTexture {
  return fieldTexture(
    rim,
    Float32Array.from(rim.outside, (cells) => cells / rim.scale),
    1
  );
}

/** Distance off the nearest coast in map units, over the chart. */
function shoreTexture(shore: OceanField): DataTexture {
  return fieldTexture(
    shore,
    Float32Array.from(shore.distances, (cells) => cells / shore.scale),
    1
  );
}

/**
 * The chart's sea, shaded in the material from the ocean field: the shore's
 * shade stepping to deep water by the depth level, deep water to ocean blue
 * by the open level, the shallows a soft band off every coast, and the surf
 * breaking just outside each archipelago's rim. Surface motion and drift
 * read the shared weather clock, independently of the camera. The shared
 * paper surface is thinned over wrecks as the camera comes in.
 */
export function createWaterMaterial(options: {
  /** The chart's extent, which the shore field covers. */
  chart: Pick<SpyglassData, "height" | "width">;
  /** The rims' distance field, for the surf. */
  rim: RimField;
  /** The sea's extent, which the shade field covers and the material's plane fills. */
  sea: SpyglassData;
  shade: OceanField;
  shore: OceanField;
  /** The scene's weather, for rim surf and subsurface drift. */
  weather: WeatherNodes;
}) {
  const { chart, rim, sea, shade, shore, weather } = options;
  const wrecks = !!sea.formerPackages?.length;
  const mask = wrecks ? wreckMask(sea) : undefined;
  const wreckReveal = uniform(0.2);
  const drawn = { depth: uniform(1), shallows: uniform(1) };
  const foundations = createFoundationTexture(sea.foundationGroups ?? [], sea);
  const foundationVisibility = uniform(1);
  const foundationSample = sampleTexture(
    foundations.texture,
    vec2(uv().x, float(1).sub(uv().y))
  );
  const foundationLevel = foundationSample.r.mul(foundationVisibility);
  const foundationShade = float(1)
    .sub(exp(foundationLevel.mul(-0.045)))
    .mul(0.55);
  const foundationRim = float(1)
    .sub(exp(foundationSample.g.mul(-0.12)))
    .mul(foundationVisibility)
    .mul(0.2);
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
  const level = sampleTexture(levels, uv());
  const depths = mix(
    color(grounds.shoreWater),
    color(grounds.deepWater),
    level.r
  );
  const offshore = mix(
    color(grounds.openWater),
    mix(depths, color(grounds.openWater), level.g),
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
  material.colorNode = paperSurface(
    mix(
      mix(
        mix(offshore, color("#456f6c"), foundationShade.add(foundationRim)),
        color(grounds.shallows),
        shallow.mul(drawn.shallows)
      ),
      color(grounds.surf),
      surf
    ),
    {
      driftLight: (point) =>
        mix(float(1), weather.driftLight(point), foundationLevel.clamp(0, 1)),
    }
  );
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
    configure(composition: SceneComposition, focus = "") {
      foundationVisibility.value = isSceneLayerVisible(
        composition,
        "dependency-foundations"
      )
        ? 1
        : 0;
      foundations.setFocus(focus);
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
      foundations.texture.dispose();
      foundationVisibility.dispose();
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
