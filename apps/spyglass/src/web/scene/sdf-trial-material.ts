import { Color, Vector2 } from "three";
import {
  attribute,
  cameraFar,
  cameraNear,
  color,
  cross,
  dFdx,
  dFdy,
  float,
  fwidth,
  max,
  mix,
  mx_noise_float,
  normalLocal,
  orthographicDepthToViewZ,
  positionView,
  positionWorld,
  screenUV,
  smoothstep,
  uniform,
  vec2,
  vec3,
  viewportDepthTexture,
  viewportSharedTexture,
} from "three/tsl";
import { MeshBasicNodeMaterial, type Node, type Texture } from "three/webgpu";
import type { GeologyGrid } from "../../lib/visualization/geology";
import { noiseSeed } from "../../lib/visualization/noise";
import { refractedCosine } from "../../lib/visualization/sdf-water";
import { kernelNoise } from "../../lib/visualization/terrain-kernel-noise";
import { defaultWaterOptics } from "../layout/water-optics";
import { landSurfaceNode } from "./geology-land";
import {
  defaultGeologyPreviewSettings,
  type GeologyPreviewSettings,
  plateLight,
  terracePass,
} from "./geology-layer";
import { terrainLightNode } from "./geology-light";
import {
  depthNode,
  landToneNode,
  seabedAlbedoNode,
} from "./screen-terrain-material";
import { splineSample, stepsNode } from "./screen-terrain-seabed";
import { nodeMath } from "./terrain-kernel-tsl";
import { waterOpticsNode } from "./water-optics";

/**
 * The SDF trial's materials. The terrain is shaded with the geology
 * preview's own look, lit but with no water over it: the land's pigment,
 * sand, escarpments and strata, the seabed's sand and sediment, the
 * terrain light, and the sky, sun and curvature baked at each vertex. The
 * water is a sheet drawn after it that reads what lies under it from the
 * frame, the colour and the depth: the refracted path through the water
 * to the terrain, read as the preview's optical depth, so the palette
 * holds top-down and a slanted view reads deeper.
 */

/** Cosine past which an interpolated normal gives way to its facet's, so a lip stays crisp on an indexed mesh. */
const creaseCosine = Math.cos((28 * Math.PI) / 180);

/** Elevation over the water across which the land's fine relief comes in. */
const waterlineRelief = 0.004;

/**
 * The terrain's material: `pigment` is the island's, linear. The mesh
 * carries a `shade` attribute: the sky's share, the sun's and the
 * curvature, elevation units.
 */
export function sdfTerrainMaterial(options: {
  pigment: Color;
  /** The screen terrain's macro field over the world grid, whose step coordinate cuts the seabed's plates. */
  plates: { grid: GeologyGrid; macro: Texture };
  settings?: GeologyPreviewSettings;
}) {
  const { pigment, plates, settings = defaultGeologyPreviewSettings } = options;
  const X = settings.exaggeration;
  const shade = attribute<"vec3">("shade", "vec3");
  const sky = shade.x;
  const sun = shade.y;
  const curvature = shade.z;
  const elevation = positionWorld.z.div(X);
  const smooth = normalLocal.normalize();
  // The facet's normal, turned to the side the vertices face.
  const facet = cross(dFdx(positionWorld), dFdy(positionWorld)).normalize();
  const facing = facet.mul(facet.dot(smooth).sign().max(0).mul(2).sub(1));
  const normal = smooth
    .dot(facing)
    .lessThan(creaseCosine)
    .select(facing, smooth)
    .toVar();
  const lift = max(normal.z, 0.05).mul(X);
  // The chart's gradient, y down the chart, elevation a map unit.
  const gradient = vec2(normal.x.negate(), normal.y).div(lift);
  const underwater = float(1).sub(smoothstep(-0.001, 0, elevation));

  const point = vec2(positionWorld.x, positionWorld.y.negate());
  const mottleSettings = settings.relief.mottle;
  const mottle = kernelNoise(nodeMath).fbm(
    point.x.div(mottleSettings.wavelength),
    point.y.div(mottleSettings.wavelength),
    nodeMath.uint(noiseSeed(mottleSettings.seed)),
    { gain: 0.5, lacunarity: 2, octaves: mottleSettings.octaves }
  );
  const seabed = seabedAlbedoNode(settings.seabed, {
    curvature,
    depth: depthNode(elevation),
    mottle,
    slope: gradient.length(),
  });
  const tread = landToneNode(settings.land, {
    curvature,
    elevation,
    gradient,
    pigment: vec3(pigment.r, pigment.g, pigment.b),
  });
  const land = landSurfaceNode({
    albedo: tread,
    elevation,
    exaggeration: X,
    normal,
    settings: settings.land,
    sky,
  });
  const waterline = max(
    underwater,
    smoothstep(0, waterlineRelief, elevation).oneMinus()
  );
  const light = terrainLightNode({
    fill: mix(
      float(settings.light.fill.land),
      float(settings.light.fill.seabed),
      underwater
    ),
    normal: mix(land.normal, normal, waterline),
    relief: mix(
      float(settings.light.relief.land),
      float(settings.light.relief.seabed),
      underwater
    ),
    settings: settings.light,
    sky: mix(land.sky, sky, underwater),
    sun,
  });
  // The plates read as cut paper, as the preview's: from the traced step
  // coordinate per pixel, multiplying the lit seabed before the water.
  const field = splineSample(plates.macro, plates.grid, point.x, point.y);
  const steps = stepsNode(
    field.value.y,
    vec2(field.slopeX.y, field.slopeY.y),
    field.value.w
  );
  const plate = mix(
    float(1),
    plateLight({
      depth: depthNode(elevation).add(underwater.mul(settings.shoreline.depth)),
      settings: settings.terraces,
      steps,
      terrace: terracePass,
    }),
    underwater
  );
  const material = new MeshBasicNodeMaterial();
  material.colorNode = mix(land.albedo, seabed.mul(plate), underwater).mul(
    light
  );
  return material;
}

/** The water sheet's tunables. */
export const defaultSdfWaterSettings = {
  /** The sky's reflection by Fresnel, kept faint: its share at grazing light. */
  reflection: 0.5,
  /** Map units the refraction shifts what lies under the water, a world unit of depth, at most `most` world units deep. */
  refraction: { most: 3, shift: 0.35 },
  /** The surface's gentle swell: its wavelength in map units, slope and drift a second. */
  swell: { drift: 0.15, slope: 0.08, wavelength: 9 },
};

/** The view's angle and the clock, which the water reads each frame. */
export function sdfWaterUniforms() {
  const incidence = uniform(0);
  const values = {
    cosIncidence: uniform(1),
    cosRefracted: uniform(1),
    incidence,
    sinIncidence: uniform(0),
    time: uniform(0),
    /** The share of the view's width and height one map unit is. */
    unitUv: uniform(new Vector2()),
  };
  return {
    ...values,
    write(
      view: { height: number; tilt?: number; width: number },
      time: number
    ) {
      const tilt = view.tilt ?? 0;
      values.incidence.value = tilt;
      values.cosIncidence.value = Math.cos(tilt);
      values.sinIncidence.value = Math.sin(tilt);
      values.cosRefracted.value = refractedCosine(tilt);
      values.time.value = time;
      values.unitUv.value.set(
        1 / Math.max(view.width, 1e-6),
        1 / Math.max(view.height, 1e-6)
      );
    },
  };
}

export type SdfWaterUniforms = ReturnType<typeof sdfWaterUniforms>;

/**
 * The water sheet over the terrain at the water level: transparent, drawn
 * after the terrain, reading the frame's depth and colour under it.
 */
export function sdfWaterMaterial(options: {
  settings?: GeologyPreviewSettings;
  uniforms: SdfWaterUniforms;
  water?: typeof defaultSdfWaterSettings;
}) {
  const {
    settings = defaultGeologyPreviewSettings,
    uniforms,
    water = defaultSdfWaterSettings,
  } = options;
  const X = settings.exaggeration;
  // World units of view ray from the water to what the frame holds at `uv`.
  const pathAt = (at: Node<"vec2">) =>
    positionView.z.sub(
      orthographicDepthToViewZ(viewportDepthTexture(at), cameraNear, cameraFar)
    );
  // A gentle swell: gradient noise drifting with the clock, as a normal.
  const swellAt = (offset: [number, number]) =>
    mx_noise_float(
      vec3(
        positionWorld.xy.add(vec2(...offset)).div(water.swell.wavelength),
        uniforms.time.mul(water.swell.drift)
      )
    );
  const step = 0.5;
  const slopeX = swellAt([step, 0]).sub(swellAt([-step, 0]));
  const slopeY = swellAt([0, step]).sub(swellAt([0, -step]));
  const surface = vec3(
    slopeX.mul(-water.swell.slope),
    slopeY.mul(-water.swell.slope),
    1
  ).normalize();
  // Straight under the pixel, then shifted by the swell's refraction; a
  // shifted read that lands on something over the water keeps the straight one.
  const straight = pathAt(screenUV).mul(uniforms.cosIncidence).toVar();
  const shift = surface.xy
    .mul(water.refraction.shift)
    .mul(straight.clamp(0, water.refraction.most))
    .mul(uniforms.unitUv)
    .mul(vec2(1, -1));
  const shiftedUv = screenUV.add(shift);
  const shifted = pathAt(shiftedUv).mul(uniforms.cosIncidence);
  const useShift = shifted.greaterThan(0);
  const uv = useShift.select(shiftedUv, screenUV);
  const below = max(useShift.select(shifted, straight), 0);
  const seabed = viewportSharedTexture(uv).rgb;
  // The refracted path's length, as the elevation whose depth the optics read.
  const path = below.div(uniforms.cosRefracted);
  const depth = depthNode(path.div(X).negate()).add(settings.shoreline.depth);
  const optics = waterOpticsNode({ depth, seabedColour: seabed });
  // Fresnel (Schlick) toward the camera, faint: the sky in the swell.
  const toCamera = vec3(
    0,
    uniforms.sinIncidence.negate(),
    uniforms.cosIncidence
  );
  const cosine = surface.dot(toCamera).clamp(0, 1);
  const fresnel = float(0.02).add(float(0.98).mul(cosine.oneMinus().pow(5)));
  const [skyRed, skyGreen, skyBlue] = defaultWaterOptics.sky;
  const reflected = mix(
    optics.colour,
    vec3(skyRed, skyGreen, skyBlue),
    fresnel.mul(water.reflection)
  );
  // A thin line of foam where the water is shallowest on screen.
  const { foam } = settings.shoreline;
  const pixelsDeep = below.div(max(fwidth(below), 1e-6));
  const foamShare = float(1)
    .sub(smoothstep(foam.width - 0.5, foam.width + 0.5, pixelsDeep))
    .mul(foam.strength);
  const material = new MeshBasicNodeMaterial();
  material.colorNode = mix(reflected, color(new Color(foam.colour)), foamShare);
  material.transparent = true;
  material.depthWrite = false;
  return {
    dispose() {
      material.dispose();
      optics.dispose();
    },
    material,
  };
}
