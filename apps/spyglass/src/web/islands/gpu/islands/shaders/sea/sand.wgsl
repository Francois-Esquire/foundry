import { planarHash, planarHash2, planarNoise } from "../../../../shaders/noise/planar.wgsl";

const RIPPLE_BEND = 6.0;
const RIPPLE_PATCH = 14.0;
const RIPPLE_BEND_SALT = 780u;
const RIPPLE_PATCH_SALT = 781u;

export fn sandRipples(p: vec2f, coast: f32, spacing: f32, footprint: f32) -> f32 {
  let bend = 1.5 * planarNoise(p / (RIPPLE_BEND * spacing), 1u, RIPPLE_BEND_SALT);
  let crest = 0.5 + 0.5 * sin(6.2831853 * (coast / spacing + bend));
  let patches = smoothstep(-0.3, 0.4, planarNoise(p / (RIPPLE_PATCH * spacing), 1u, RIPPLE_PATCH_SALT));
  let resolved = 1.0 - smoothstep(0.12, 0.35, footprint / spacing);
  return (crest * crest * crest - 0.3) * patches * resolved;
}

const SPECK_RADIUS = 0.12;
const SPECK_SALT = 790u;
const SPECK_PLACE_SALT = 791u;

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
