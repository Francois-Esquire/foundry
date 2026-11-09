// The finish: the water's linear frame with the bloom added, a warm
// vignette, a shoulder that rolls off only what the bloom pushes past
// SHOULDER (everything below it is untouched), and the sRGB encoding, into
// the display-referred image the anti-aliasing reads.

struct Finish {
  vignetteColor: vec3f,
  // The vignette's strength, 0 for none.
  vignette: f32,
  // What the bloom chain's sum is multiplied by: its strength over its gain.
  bloom: f32,
}

@group(0) @binding(0) var<uniform> finish: Finish;
@group(0) @binding(1) var scene: texture_2d<f32>;
// The bloom chain's top level, half the frame's size.
@group(0) @binding(2) var glow: texture_2d<f32>;
@group(0) @binding(3) var linear: sampler;

// Linear brightness past which a channel rolls off toward 1.
const SHOULDER = 0.85;

fn shouldered(c: vec3f) -> vec3f {
  let over = max(c - SHOULDER, vec3f(0.0));
  let rolled = SHOULDER + (1.0 - SHOULDER) * (1.0 - exp(-over / (1.0 - SHOULDER)));
  return select(c, rolled, c > vec3f(SHOULDER));
}

fn encode(linear: vec3f) -> vec3f {
  let c = saturate(linear);
  return select(1.055 * pow(c, vec3f(1.0 / 2.4)) - 0.055, 12.92 * c, c <= vec3f(0.0031308));
}

fn vignetted(color: vec3f, uv: vec2f) -> vec3f {
  let size = vec2f(textureDimensions(scene));
  let centred = (uv - 0.5) * vec2f(size.x / size.y, 1.0);
  let amount = smoothstep(0.45, 1.25, length(centred)) * finish.vignette;
  return mix(color, color * finish.vignetteColor + finish.vignetteColor * vec3f(0.064, 0.05, 0.025), amount);
}

@fragment fn fs_main(@location(0) uv: vec2f) -> @location(0) vec4f {
  var color = textureSampleLevel(scene, linear, uv, 0.0).rgb;
  color += textureSampleLevel(glow, linear, uv, 0.0).rgb * finish.bloom;
  return vec4f(encode(shouldered(vignetted(color, uv))), 1.0);
}
