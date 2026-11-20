import { bloomDownsample, bloomPrefilter, bloomUpsample } from "../../../../shaders/post/bloom.wgsl";

struct Bloom {
  texel: vec2f,
  threshold: f32,
  knee: f32,
  radius: f32,
  weight: f32,
}
@group(0) @binding(0) var<uniform> bloom: Bloom;
@group(0) @binding(1) var source: texture_2d<f32>;
@group(0) @binding(2) var sourceSampler: sampler;

@fragment fn fs_bright(@location(0) uv: vec2f) -> @location(0) vec4f {
  let color = bloomDownsample(source, sourceSampler, uv, bloom.texel);
  return vec4f(bloomPrefilter(color, bloom.threshold, bloom.knee), 1.0);
}

@fragment fn fs_down(@location(0) uv: vec2f) -> @location(0) vec4f {
  return vec4f(bloomDownsample(source, sourceSampler, uv, bloom.texel), 1.0);
}

@fragment fn fs_up(@location(0) uv: vec2f) -> @location(0) vec4f {
  return vec4f(bloomUpsample(source, sourceSampler, uv, bloom.texel, bloom.radius) * bloom.weight, 1.0);
}
