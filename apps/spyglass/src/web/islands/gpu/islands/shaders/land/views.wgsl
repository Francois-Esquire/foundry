// The debug views' colourings, pure: terrain.wgsl drapes them over the mesh.

// A signed distance as a ramp: sea (positive) pale to deep blue, land
// (negative) pale to deep orange, both saturating at `reach`. Thin contours
// every quarter reach, and a dark line on the coast, `fw` (the distance's
// screen derivative) keeping both a pixel wide.
export fn mapRamp(d: f32, reach: f32, fw: f32) -> vec3f {
  let t = saturate(abs(d) / max(reach, 1e-6));
  let sea = mix(vec3f(0.78, 0.9, 1.0), vec3f(0.05, 0.18, 0.55), t);
  let land = mix(vec3f(1.0, 0.86, 0.68), vec3f(0.55, 0.2, 0.04), t);
  var color = select(sea, land, d < 0.0);
  let spacing = max(reach, 1e-6) * 0.25;
  let band = abs(fract(d / spacing + 0.5) - 0.5) * spacing;
  let contour = 1.0 - smoothstep(0.0, max(fw, 1e-6), band);
  color = mix(color, color * 0.7, contour);
  let coast = 1.0 - smoothstep(0.0, max(fw, 1e-6) * 1.5, abs(d));
  return mix(color, vec3f(0.0), coast);
}

const TAU = 6.2831853;
// Land in the rings view, and the sea on no bank's plate.
const RINGS_LAND = vec3f(0.12);
const RINGS_NONE = vec3f(0.02, 0.03, 0.06);
// The golden turn: neighbouring ids get hues far apart.
const GOLDEN = 0.618034;
// Land in the flow view: a flat grey, so the coasts read against the sea.
const FLOW_LAND = vec3f(0.08);
const FLOW_SEA = vec3f(0.02, 0.03, 0.06);
const FLOW_SAND = vec3f(0.95, 0.82, 0.55);
// The sediment hatch's period, screen pixels.
const HATCH_PIXELS = 6.0;
// The breaking the flow view outlines: where the surf zone begins.
const SURF_EDGE = 0.05;

// A fully saturated hue, `turn` 0–1 round the wheel from red.
fn hue(turn: f32) -> vec3f {
  return saturate(abs(fract(turn + vec3f(0.0, 2.0 / 3.0, 1.0 / 3.0)) * 6.0 - 3.0) - 1.0);
}

// The flow map (`f`: transport x and chart y, breaking, sediment) at chart
// point `xz`, `d` the signed distance there. Hue by the transport's
// direction (east red, south green, west cyan, north violet), brightness by
// its speed against `full`; a white line where breaking begins, the surf
// zone's seaward edge; sediment as a sand hatch, denser where there is
// more. `fw` is the distance's screen derivative, chart units a pixel.
export fn flowKey(f: vec4f, d: f32, xz: vec2f, full: f32, fw: f32) -> vec3f {
  let surf = f.z - SURF_EDGE;
  let surfWidth = max(fwidth(surf), 1e-6);
  let speed = length(f.xy);
  let direction = hue(atan2(f.y, f.x) / TAU + 1.0);
  var color = mix(FLOW_SEA, direction, saturate(speed / max(full, 1e-6)));
  let edge = 1.0 - smoothstep(0.0, 1.5 * surfWidth, abs(surf));
  color = mix(color, vec3f(1.0), edge * 0.85);
  let period = HATCH_PIXELS * max(fw, 1e-6);
  let stripe = fract(dot(xz, vec2f(0.70710678, 0.70710678)) / period);
  let hatch = 1.0 - smoothstep(0.0, 1.0 / HATCH_PIXELS, stripe - 0.5 * f.w);
  color = mix(color, FLOW_SAND, 0.7 * hatch * f32(f.w > 0.0));
  return select(color, FLOW_LAND, d < 0.0);
}

// The rings map (`ring`: a bank's id + 1, 0 for none) at a point `d` from
// the coast: each bank its own hue, land grey.
export fn ringKey(ring: u32, d: f32) -> vec3f {
  if (d < 0.0) {
    return RINGS_LAND;
  }
  if (ring == 0u) {
    return RINGS_NONE;
  }
  let turn = fract(f32(ring) * GOLDEN);
  return mix(vec3f(0.85), hue(turn), 0.7 - 0.25 * f32(ring % 2u));
}
