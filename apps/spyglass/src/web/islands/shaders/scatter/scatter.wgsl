import { planarHash } from "../noise/planar.wgsl";

export struct ScatterCandidate {
  point: vec2f,
  rolls: vec4f,
}

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

export fn scatterKeep(density: f32, roll: f32) -> bool {
  return roll < clamp(density, 0.0, 1.0);
}

export fn scatterClumps(noise: f32, coverage: f32, softness: f32) -> f32 {
  let threshold = (0.5 - clamp(coverage, 0.0, 1.0)) * 1.1;
  return smoothstep(threshold - softness, threshold + softness, noise);
}

export fn scatterFrame(normal: vec3f, follow: f32, turn: f32) -> mat3x3f {
  let up = normalize(mix(vec3f(0.0, 1.0, 0.0), normal, clamp(follow, 0.0, 1.0)));
  let reference = select(vec3f(0.0, 0.0, 1.0), vec3f(1.0, 0.0, 0.0), abs(up.z) > 0.9);
  let right = normalize(cross(up, reference));
  let forward = cross(right, up);
  let c = cos(turn);
  let s = sin(turn);
  return mat3x3f(right * c + forward * s, up, forward * c - right * s);
}

export fn scatterPixels(viewProjection: mat4x4f, center: vec3f, radius: f32, viewport: vec2f) -> f32 {
  let w = (viewProjection * vec4f(center, 1.0)).w;
  if (w <= 1e-4) { return 0.0; }
  let scale = length(vec3f(viewProjection[0].y, viewProjection[1].y, viewProjection[2].y));
  return radius * scale * viewport.y * 0.5 / w;
}

export fn scatterFade(pixels: f32, start: f32, end: f32) -> f32 {
  return smoothstep(start, end, pixels);
}
