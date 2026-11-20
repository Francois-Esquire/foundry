import { MapFrame } from "./frame.wgsl";

struct LightParams {
  frame: MapFrame,
  sun: vec3f,
  ceiling: f32,
  reach: f32,
  blur: f32,
}

@group(0) @binding(0) var<uniform> params: LightParams;
@group(0) @binding(1) var height: texture_2d<f32>;
@group(0) @binding(2) var linear: sampler;
@group(0) @binding(3) var light: texture_storage_2d<rgba16float, write>;
@group(0) @binding(4) var shade: texture_storage_2d<rgba8unorm, write>;

const TAU = 6.2831853;
const HORIZON_DIRECTIONS = 12u;
const HORIZON_RINGS = 8u;
const RING_SPREAD = 1.7;
const RING_FOOTPRINT = 6.0;
const SUN_RADIUS = 0.04;
const MAX_BLURRED = 0.75;
const MARCH_STEPS = 64u;
const MARCH_SPREAD = 1.08;

fn heightAt(texel: vec2i) -> f32 {
  let last = vec2i(i32(params.frame.resolution) - 1);
  return textureLoad(height, clamp(texel, vec2i(0), last), 0).r;
}

fn heightNear(p: vec2f) -> f32 {
  return heightAround(p, 0.0);
}

fn heightAround(p: vec2f, lod: f32) -> f32 {
  let side = params.frame.texel * f32(params.frame.resolution);
  return textureSampleLevel(height, linear, (p - params.frame.origin) / side, lod).r;
}

fn texelNoise(texel: vec2f) -> f32 {
  return fract(52.9829189 * fract(dot(texel, vec2f(0.06711056, 0.00583715))));
}

fn openSky(p: vec2f, h: f32, slope: vec2f, texel: vec2f) -> f32 {
  let first = texelNoise(texel) * TAU / f32(HORIZON_DIRECTIONS);
  let slide = texelNoise(texel.yx + vec2f(17.0, 59.0));
  let start = params.reach * exp2(slide * log2(RING_SPREAD));
  let startLod = log2(params.reach / (RING_FOOTPRINT * params.frame.texel));
  let step = TAU / f32(HORIZON_DIRECTIONS);
  let turn = mat2x2f(cos(step), sin(step), -sin(step), cos(step));
  var toward = vec2f(cos(first), sin(first));
  var open = 0.0;
  for (var d = 0u; d < HORIZON_DIRECTIONS; d++) {
    let tangent = dot(slope, toward);
    var steepest = 0.0;
    var radius = start;
    var lod = startLod;
    for (var r = 0u; r < HORIZON_RINGS; r++) {
      let rise = (heightAround(p + toward * radius, max(lod, 0.0)) - h) / radius - tangent;
      steepest = max(steepest, rise);
      radius *= RING_SPREAD;
      lod += log2(RING_SPREAD);
    }
    open += inverseSqrt(1.0 + steepest * steepest);
    toward = turn * toward;
  }
  return open / f32(HORIZON_DIRECTIONS);
}

fn sunVisibility(p: vec2f, h: f32) -> vec2f {
  let sun = params.sun;
  let across = length(sun.xz);
  if (across < 1e-5) {
    return vec2f(1.0);
  }
  let toward = sun.xz / across;
  let elevation = atan2(sun.y, across);
  let depth = max(-h, 0.0);
  let widest = max(MAX_BLURRED * elevation - SUN_RADIUS, 0.0);
  let floorRadius = SUN_RADIUS + min(params.blur * depth, widest);
  let floorLowest = tan(max(elevation - floorRadius, 0.0));
  let surfaceLowest = tan(max(elevation - SUN_RADIUS, 0.0));
  var floorSun = 1.0;
  var surfaceSun = 1.0;
  var surfaceDone = h >= 0.0;
  var r = params.reach;
  for (var s = 0u; s < MARCH_STEPS; s++) {
    let ground = heightNear(p + toward * r);
    let blocked = atan2(ground - h, r);
    floorSun = min(floorSun, saturate((elevation - blocked) / (2.0 * floorRadius) + 0.5));
    if (!surfaceDone) {
      let over = atan2(ground, r);
      surfaceSun = min(surfaceSun, saturate((elevation - over) / (2.0 * SUN_RADIUS) + 0.5));
      surfaceDone = surfaceSun <= 0.0 || r * surfaceLowest > params.ceiling;
    }
    let floorDone = floorSun <= 0.0 || h + r * floorLowest > params.ceiling;
    if (floorDone && surfaceDone) {
      break;
    }
    r = r * MARCH_SPREAD + 0.5 * params.reach;
  }
  return vec2f(floorSun, select(surfaceSun, floorSun, h >= 0.0));
}

@compute @workgroup_size(8, 8)
fn cs_main(@builtin(global_invocation_id) id: vec3u) {
  let n = params.frame.resolution;
  if (id.x >= n || id.y >= n) {
    return;
  }
  let texel = vec2i(id.xy);
  let h = heightAt(texel);
  let span = 2.0 * params.frame.texel;
  let fallX = (heightAt(texel - vec2i(1, 0)) - heightAt(texel + vec2i(1, 0))) / span;
  let fallZ = (heightAt(texel - vec2i(0, 1)) - heightAt(texel + vec2i(0, 1))) / span;
  let normal = normalize(vec3f(fallX, 1.0, fallZ));
  let p = params.frame.origin + (vec2f(id.xy) + 0.5) * params.frame.texel;
  let sky = openSky(p, h, -vec2f(fallX, fallZ), vec2f(id.xy));
  let sunlit = sunVisibility(p, h);
  textureStore(light, id.xy, vec4f(normal.x, normal.z, sky, sunlit.x));
  textureStore(shade, id.xy, vec4f(sunlit.y, 0.0, 0.0, 0.0));
}
