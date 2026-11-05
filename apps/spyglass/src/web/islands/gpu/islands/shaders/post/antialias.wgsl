// The anti-aliasing: FXAA (shaders/post/fxaa.wgsl) over the finished,
// display-referred frame, onto the output; or the frame as it is.
import { fxaa } from "../../../../shaders/post/fxaa.wgsl";

struct Antialias {
  // 1 runs FXAA; 0 copies.
  enabled: f32,
}

@group(0) @binding(0) var<uniform> antialias: Antialias;
@group(0) @binding(1) var finished: texture_2d<f32>;
@group(0) @binding(2) var linear: sampler;

@fragment fn fs_main(@location(0) uv: vec2f) -> @location(0) vec4f {
  if (antialias.enabled < 0.5) {
    return vec4f(textureSampleLevel(finished, linear, uv, 0.0).rgb, 1.0);
  }
  let texel = 1.0 / vec2f(textureDimensions(finished));
  return vec4f(fxaa(finished, linear, uv, texel), 1.0);
}
