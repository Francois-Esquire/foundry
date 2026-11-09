// The light map: what shading would otherwise recompute every frame, from
// the height map alone. Per texel: the surface normal from the height's
// gradient, ambient occlusion from the horizon around the texel, and the
// sun's visibility from a march toward the sun over the heights. The same
// march, from the same texel at sea level, gives the shade map: the sun's
// visibility at the sea surface above the floor, which the water's own
// light takes (water.wgsl). It is not the light map's at the floor: the
// floor's shadow edge lies farther from the land by the depth times the
// sun's run over its rise.
import { MapFrame } from "./frame.wgsl";

struct LightParams {
  frame: MapFrame,
  // Unit direction toward the sun, world space: x east, y up, z south.
  sun: vec3f,
  // The highest the land stands: a sun ray above it can no longer be
  // blocked, so the march stops.
  ceiling: f32,
  // Chart units of the occlusion's first ring and the march's first step:
  // fixed in chart units, so a finer map shades the same, only sharper.
  reach: f32,
  // Radians the sun's apparent radius grows per chart unit of water over
  // the floor (sea-params.ts `shadowBlur`).
  blur: f32,
}

@group(0) @binding(0) var<uniform> params: LightParams;
@group(0) @binding(1) var height: texture_2d<f32>;
@group(0) @binding(2) var linear: sampler;
// normal.x, normal.z, ambient occlusion, sun visibility.
@group(0) @binding(3) var light: texture_storage_2d<rgba16float, write>;
// r: the sun's visibility at the sea surface over the texel (at the land's
// own height on land, where it is the light map's); g, b, a reserved, 0.
@group(0) @binding(4) var shade: texture_storage_2d<rgba8unorm, write>;

const TAU = 6.2831853;
// The occlusion's directions and the radii along each, spaced geometrically
// from the first ring's `reach` out to about 40 reaches. Each texel turns
// its set of directions and slides its radii by its own noise, so no
// direction or ring is shared by neighbours and the pattern dissolves.
const HORIZON_DIRECTIONS = 12u;
const HORIZON_RINGS = 8u;
const RING_SPREAD = 1.7;
const RING_FOOTPRINT = 6.0;
// The sun's angular radius: the width of a shadow's penumbra in air, and
// the lowest elevation at which open flat ground is still fully lit. Under
// water it widens by `params.blur` a unit of depth.
const SUN_RADIUS = 0.04;
// The widened disc's radius never passes this share of the sun's elevation.
const MAX_BLURRED = 0.75;
const MARCH_STEPS = 64u;
const MARCH_SPREAD = 1.08;

fn heightAt(texel: vec2i) -> f32 {
  let last = vec2i(i32(params.frame.resolution) - 1);
  return textureLoad(height, clamp(texel, vec2i(0), last), 0).r;
}

// The height at a chart point, bilinear; reads past the edge clamp.
fn heightNear(p: vec2f) -> f32 {
  return heightAround(p, 0.0);
}

// The height at a chart point from mip `lod`: averaged over about 2^lod
// texels, which is all a far horizon sample needs, and cheap to fetch.
fn heightAround(p: vec2f, lod: f32) -> f32 {
  let side = params.frame.texel * f32(params.frame.resolution);
  return textureSampleLevel(height, linear, (p - params.frame.origin) / side, lod).r;
}

// Interleaved gradient noise: a per-texel value in [0, 1) whose
// neighbours differ as much as possible, so a pattern turned by it
// averages out over a few texels instead of leaving grain.
fn texelNoise(texel: vec2f) -> f32 {
  return fract(52.9829189 * fract(dot(texel, vec2f(0.06711056, 0.00583715))));
}

// The share of the sky open above the horizon around p, standing at h on a
// surface sloping by `slope` (rise per chart unit along x and chart y):
// each direction's horizon is the steepest rise above the tangent plane
// over the rings, and it leaves the cosine of its elevation open. Measured
// from the tangent plane, an even slope occludes nothing; only a surface
// that bends up toward the sky does.
fn openSky(p: vec2f, h: f32, slope: vec2f, texel: vec2f) -> f32 {
  let first = texelNoise(texel) * TAU / f32(HORIZON_DIRECTIONS);
  let slide = texelNoise(texel.yx + vec2f(17.0, 59.0));
  let start = params.reach * exp2(slide * log2(RING_SPREAD));
  // The footprint follows the ring, not the slide, so neighbours read the
  // same mip level and their fetches stay together.
  let startLod = log2(params.reach / (RING_FOOTPRINT * params.frame.texel));
  // Each direction is the one before turned by a fixed step.
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
      // A ring's samples stand about half its radius apart, so a footprint
      // of a sixth of it is all the detail they can tell apart.
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

// How much of the sun's disc p sees over the heights between them, from
// the floor at h (x) and from the sea surface above it (y; on land the
// same as x). Light scatters on its way down through the water, so seen
// from the floor the disc's radius grows by `blur` a unit of depth: a
// shadow lies crisp on the shoal and blurs out over the deep. The two
// marches share every height sample. The surface's starts at sea level, so
// it clears the land within a few plate heights and stops there; on land it
// is the floor's own and is not marched at all.
fn sunVisibility(p: vec2f, h: f32) -> vec2f {
  let sun = params.sun;
  let across = length(sun.xz);
  if (across < 1e-5) {
    return vec2f(1.0);
  }
  let toward = sun.xz / across;
  let elevation = atan2(sun.y, across);
  let depth = max(-h, 0.0);
  // The widening stops short of the sun's own height: past it open flat
  // floor would fall into its own penumbra and the early-out never come.
  let widest = max(MAX_BLURRED * elevation - SUN_RADIUS, 0.0);
  let floorRadius = SUN_RADIUS + min(params.blur * depth, widest);
  // Each disc's lower edge: once a ray at it clears the ceiling, nothing
  // farther can block any of that sun.
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
  // Chart y runs south, which is world z.
  // Downhill along x and z: on flat ground +0, never -0.
  let fallX = (heightAt(texel - vec2i(1, 0)) - heightAt(texel + vec2i(1, 0))) / span;
  let fallZ = (heightAt(texel - vec2i(0, 1)) - heightAt(texel + vec2i(0, 1))) / span;
  let normal = normalize(vec3f(fallX, 1.0, fallZ));
  let p = params.frame.origin + (vec2f(id.xy) + 0.5) * params.frame.texel;
  let sky = openSky(p, h, -vec2f(fallX, fallZ), vec2f(id.xy));
  let sunlit = sunVisibility(p, h);
  textureStore(light, id.xy, vec4f(normal.x, normal.z, sky, sunlit.x));
  textureStore(shade, id.xy, vec4f(sunlit.y, 0.0, 0.0, 0.0));
}
