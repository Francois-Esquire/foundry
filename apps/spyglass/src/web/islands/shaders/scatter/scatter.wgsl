// Procedural scatter: small objects placed from baked maps. One candidate
// per grid cell, at a jittered point, kept with probability `density`
// (thinning), then stood on the ground and turned. Everything is a hash of
// the cell, so placement is deterministic, needs no sort, and doesn't move
// when the camera does; raising a density only adds instances. The entry
// shader owns the maps and the instance buffer.
import { planarHash } from "../noise/planar.wgsl";

export struct ScatterCandidate {
  // Where the candidate sits, in cell units: the cell plus its jitter.
  point: vec2f,
  // Four independent rolls in [0, 1): keep, variant, size, turn.
  rolls: vec4f,
}

// The candidate for a cell. `jitter` 1 puts it anywhere in its cell; below
// that it stays toward the centre, so neighbours keep at least
// (1 − jitter) cells apart: blue-noise-like spacing for free. Uses salts
// `salt` to `salt + 5`.
export fn scatterCandidate(cell: vec2i, jitter: f32, seed: u32, salt: u32) -> ScatterCandidate {
  let offset = vec2f(planarHash(cell, seed, salt), planarHash(cell, seed, salt + 1u)) - 0.5;
  var candidate: ScatterCandidate;
  candidate.point = vec2f(cell) + 0.5 + offset * clamp(jitter, 0.0, 1.0);
  candidate.rolls = vec4f(
    planarHash(cell, seed, salt + 2u),
    planarHash(cell, seed, salt + 3u),
    planarHash(cell, seed, salt + 4u),
    planarHash(cell, seed, salt + 5u),
  );
  return candidate;
}

// Thinning: keep a candidate whose roll falls under the density (clamped to
// 0–1). Rolls are per cell, so a higher density keeps a superset.
export fn scatterKeep(density: f32, roll: f32) -> bool {
  return roll < clamp(density, 0.0, 1.0);
}

// Clumping: a smooth noise value (about −1 to 1) to a 0–1 mask that covers
// about `coverage` of the ground in patches, with edges `softness` wide in
// noise units. Multiply a density by it so instances gather in groves and
// reefs instead of spreading evenly.
export fn scatterClumps(noise: f32, coverage: f32, softness: f32) -> f32 {
  let threshold = (0.5 - clamp(coverage, 0.0, 1.0)) * 1.1;
  return smoothstep(threshold - softness, threshold + softness, noise);
}

// A frame for an instance standing on ground whose normal is `normal`: its
// up leans from vertical toward the normal by `follow` (0 upright, as a
// tree; 1 flush with the ground, as a stone), then turns by `turn` radians
// about that up. Columns: right, up, forward.
export fn scatterFrame(normal: vec3f, follow: f32, turn: f32) -> mat3x3f {
  let up = normalize(mix(vec3f(0.0, 1.0, 0.0), normal, clamp(follow, 0.0, 1.0)));
  let reference = select(vec3f(0.0, 0.0, 1.0), vec3f(1.0, 0.0, 0.0), abs(up.z) > 0.9);
  let right = normalize(cross(up, reference));
  let forward = cross(right, up);
  let c = cos(turn);
  let s = sin(turn);
  return mat3x3f(right * c + forward * s, up, forward * c - right * s);
}

// About how many pixels a sphere of `radius` at `center` spans on screen,
// for a perspective view-projection. The matrix's second row, less its
// translation, is the projection's vertical scale times a unit view axis,
// so its length is that scale whatever the camera's turn: one projection,
// no field of view to pass in. Behind the eye it is 0.
export fn scatterPixels(viewProjection: mat4x4f, center: vec3f, radius: f32, viewport: vec2f) -> f32 {
  let w = (viewProjection * vec4f(center, 1.0)).w;
  if (w <= 1e-4) { return 0.0; }
  let scale = length(vec3f(viewProjection[0].y, viewProjection[1].y, viewProjection[2].y));
  return radius * scale * viewport.y * 0.5 / w;
}

// Size-based fade, 0 below `start` pixels and 1 above `end`: scale an
// instance by it so it shrinks away before it would shimmer.
export fn scatterFade(pixels: f32, start: f32, end: f32) -> f32 {
  return smoothstep(start, end, pixels);
}
