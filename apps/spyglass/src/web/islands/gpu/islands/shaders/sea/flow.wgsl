import { ease } from "../maps/frame.wgsl";

export struct Swell {
  heading: vec2f,
  length: f32,
  breakDepth: f32,
  speed: f32,
  drift: f32,
}

const DIFFRACTION = 0.5;
const BREAK_FULL = 0.5;
const SWASH_KEEP = 0.2;

export fn diffractionEdge(swell: Swell, range: f32) -> f32 {
  return DIFFRACTION * sqrt(swell.length * max(range, 0.0));
}

export fn diffracted(clearance: f32, edge: f32) -> f32 {
  return saturate(0.5 + clearance / max(edge, 1e-4));
}

export fn breaking(swell: Swell, depth: f32, arriving: f32) -> f32 {
  if (depth <= 0.0) {
    return 0.0;
  }
  return arriving * (1.0 - ease(BREAK_FULL * swell.breakDepth, swell.breakDepth, depth));
}

export fn refracted(swell: Swell, upslope: vec2f, depth: f32) -> vec2f {
  let along = vec2f(-upslope.y, upslope.x);
  let toward = dot(swell.heading, upslope);
  let ratio = sqrt(saturate(depth / max(0.5 * swell.length, 1e-4)));
  let sine = dot(swell.heading, along) * ratio;
  let cosine = sqrt(max(1.0 - sine * sine, 0.0));
  let shoreward = select(mix(toward, cosine, 1.0 - ratio), cosine, toward >= 0.0);
  let turned = upslope * shoreward + along * sine;
  return turned / max(length(turned), 1e-4);
}

export fn incidence(heading: vec2f, upslope: vec2f) -> f32 {
  return max(dot(heading, upslope), 0.0);
}

export fn swash(swell: Swell, heading: vec2f, upslope: vec2f, depth: f32) -> vec2f {
  let dry = 1.0 - ease(0.0, BREAK_FULL * swell.breakDepth, depth);
  return heading - upslope * dot(heading, upslope) * (1.0 - SWASH_KEEP) * dry;
}

export fn stirred(swell: Swell, depth: f32, arriving: f32) -> f32 {
  let shallow = 1.0 - saturate(depth / max(swell.breakDepth, 1e-4));
  return breaking(swell, depth, arriving) * shallow;
}
