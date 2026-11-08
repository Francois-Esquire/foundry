// The shallow floor's small things, seen through the water: sand ripples
// whose crests run parallel to the coast, and gold specks, thickest on the
// levels' lips. Each fades before it would alias. Pure: the terrain
// (terrain.wgsl) shades the floor with them.
import { planarHash, planarHash2, planarNoise } from "../../../../shaders/noise/planar.wgsl";

// The crests bend over this many ripples and break into patches over this
// many, with their salts.
const RIPPLE_BEND = 6.0;
const RIPPLE_PATCH = 14.0;
const RIPPLE_BEND_SALT = 780u;
const RIPPLE_PATCH_SALT = 781u;

// A shading offset around 0 at p, `coast` from the nearest coast: crests
// `spacing` apart, sharp with broad troughs, bent and broken by slow noise.
// Gone by the time a ripple spans a few pixels of `footprint`.
export fn sandRipples(p: vec2f, coast: f32, spacing: f32, footprint: f32) -> f32 {
  let bend = 1.5 * planarNoise(p / (RIPPLE_BEND * spacing), 1u, RIPPLE_BEND_SALT);
  let crest = 0.5 + 0.5 * sin(6.2831853 * (coast / spacing + bend));
  let patches = smoothstep(-0.3, 0.4, planarNoise(p / (RIPPLE_PATCH * spacing), 1u, RIPPLE_PATCH_SALT));
  let resolved = 1.0 - smoothstep(0.12, 0.35, footprint / spacing);
  return (crest * crest * crest - 0.3) * patches * resolved;
}

// A speck's radius as a share of its cell, and its salts.
const SPECK_RADIUS = 0.12;
const SPECK_SALT = 790u;
const SPECK_PLACE_SALT = 791u;

// How much of a speck covers p, 0–1: at most one in each cell `size`
// across, `density` of the cells holding one; faded out as a speck shrinks
// under a pixel of `footprint`.
export fn specks(p: vec2f, size: f32, density: f32, footprint: f32) -> f32 {
  let cell = vec2i(floor(p / size));
  if (planarHash(cell, 1u, SPECK_SALT) >= density) {
    return 0.0;
  }
  let at = (vec2f(cell) + 0.2 + 0.6 * planarHash2(cell, 1u, SPECK_PLACE_SALT)) * size;
  let radius = SPECK_RADIUS * size;
  let dot = 1.0 - smoothstep(0.5 * radius, radius + 0.5 * footprint, length(p - at));
  return dot * (1.0 - smoothstep(radius, 3.0 * radius, footprint));
}
