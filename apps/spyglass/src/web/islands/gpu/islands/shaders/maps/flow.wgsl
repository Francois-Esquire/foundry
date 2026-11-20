import { breaking, diffracted, diffractionEdge, incidence, refracted, stirred, Swell, swash } from "../sea/flow.wgsl";
import { MapFrame, texelCenter } from "./frame.wgsl";
import { splineLevel } from "./spline.wgsl";

struct FlowParams {
  frame: MapFrame,
  swell: Swell,
  reach: f32,
}

@group(0) @binding(0) var<uniform> params: FlowParams;
@group(0) @binding(1) var distance: texture_2d<f32>;
@group(0) @binding(2) var height: texture_2d<f32>;
@group(0) @binding(3) var linear: sampler;
@group(0) @binding(4) var flow: texture_storage_2d<rgba16float, write>;

const MARCH_STEPS = 64u;
const MARCH_SPREAD = 1.08;
const SLOPE_SPAN = 2.0;
const SEDIMENT_TAPS = 4u;

fn uvOf(p: vec2f) -> vec2f {
  let side = params.frame.texel * f32(params.frame.resolution);
  return (p - params.frame.origin) / side;
}

fn distanceNear(p: vec2f) -> f32 {
  return textureSampleLevel(distance, linear, uvOf(p), 0.0).r;
}

fn distanceAcross(uv: vec2f, width: f32) -> f32 {
  let top = f32(textureNumLevels(distance) - 1u);
  let lod = clamp(log2(max(width / params.frame.texel, 1.0)), 0.0, top);
  return splineLevel(distance, linear, uv, u32(round(lod)));
}

fn depthNear(p: vec2f) -> f32 {
  return -textureSampleLevel(height, linear, uvOf(p), 0.0).r;
}

fn arriving(p: vec2f) -> f32 {
  let back = -params.swell.heading;
  var open = 1.0;
  var range = params.reach;
  for (var s = 0u; s < MARCH_STEPS; s++) {
    let q = p + back * range;
    let uv = uvOf(q);
    if (any(uv < vec2f(0.0)) || any(uv > vec2f(1.0))) {
      break;
    }
    let edge = diffractionEdge(params.swell, range);
    open = min(open, diffracted(distanceAcross(uv, edge), edge));
    if (open <= 0.0) {
      break;
    }
    range = range * MARCH_SPREAD + 0.5 * params.reach;
  }
  return open;
}

fn upslope(p: vec2f) -> vec2f {
  let e = SLOPE_SPAN * params.frame.texel;
  let dx = vec2f(e, 0.0);
  let dy = vec2f(0.0, e);
  let rise = vec2f(depthNear(p - dx) - depthNear(p + dx), depthNear(p - dy) - depthNear(p + dy));
  if (length(rise) > 1e-5 * e) {
    return normalize(rise);
  }
  let coastward = vec2f(distanceNear(p - dx) - distanceNear(p + dx), distanceNear(p - dy) - distanceNear(p + dy));
  return coastward / max(length(coastward), 1e-6);
}

@compute @workgroup_size(8, 8)
fn cs_main(@builtin(global_invocation_id) id: vec3u) {
  let n = params.frame.resolution;
  if (id.x >= n || id.y >= n) {
    return;
  }
  let swell = params.swell;
  let d = textureLoad(distance, id.xy, 0).r;
  let depth = -textureLoad(height, id.xy, 0).r;
  if (d <= 0.0 || depth <= 0.0 || depth >= swell.breakDepth) {
    textureStore(flow, id.xy, vec4f(0.0));
    return;
  }
  let p = texelCenter(params.frame, id.xy);
  let up = upslope(p);
  let heading = refracted(swell, up, depth);
  let open = arriving(p) * incidence(heading, up);
  let surf = breaking(swell, depth, open);
  if (surf <= 0.0) {
    textureStore(flow, id.xy, vec4f(0.0));
    return;
  }
  let direction = swash(swell, heading, up, depth);
  let transport = direction * surf * swell.speed;
  let behind = -direction / max(length(direction), 1e-4);
  var sediment = 0.0;
  for (var k = 0u; k < SEDIMENT_TAPS; k++) {
    let q = p + behind * swell.drift * f32(k) / f32(SEDIMENT_TAPS);
    sediment += stirred(swell, depthNear(q), open);
  }
  textureStore(flow, id.xy, vec4f(transport, surf, sediment / f32(SEDIMENT_TAPS)));
}
