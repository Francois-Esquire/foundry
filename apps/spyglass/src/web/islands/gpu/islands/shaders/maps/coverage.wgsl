// The coverage map: land as an anti-aliased value, 0 at sea and 1 on land,
// eased across the coast over `feather` texels either side.
import { ease, MapFrame } from "./frame.wgsl";

struct CoverageParams {
  frame: MapFrame,
  feather: f32,
}

@group(0) @binding(0) var<uniform> params: CoverageParams;
@group(0) @binding(1) var distance: texture_2d<f32>;

@fragment
fn fs_main(@builtin(position) position: vec4f) -> @location(0) vec4f {
  let d = textureLoad(distance, vec2u(floor(position.xy)), 0).r;
  let land = ease(-params.feather, params.feather, -d / params.frame.texel);
  return vec4f(land, 0.0, 0.0, 1.0);
}
