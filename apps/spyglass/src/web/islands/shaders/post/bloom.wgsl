// Bloom, as a chain of small fullscreen passes: a bright-pass that keeps
// what stands above a threshold (with a soft knee, so nothing pops on or
// off), downsamples that halve the image each step, then upsamples that
// walk back up adding each level into the one above. Thirteen taps down
// (the "dual box" pattern, which keeps single bright pixels from
// flickering) and a nine-tap tent up. The entry shader owns the textures
// and samplers and passes them in.

// What of `color` is bright enough to bloom: a smooth ramp over `knee`
// below `threshold`, linear above it. Works on display-referred colour too.
export fn bloomPrefilter(color: vec3f, threshold: f32, knee: f32) -> vec3f {
  let bright = max(color.r, max(color.g, color.b));
  let k = max(knee, 1e-4);
  let soft = clamp(bright - threshold + k, 0.0, 2.0 * k);
  let ramp = soft * soft / (4.0 * k);
  return color * max(ramp, bright - threshold) / max(bright, 1e-4);
}

// Thirteen taps around `uv` in a 4 × 4 texel footprint of `src` (texel =
// 1 / its size): a centre box and four corner boxes, weighted so the
// footprint sums to one.
export fn bloomDownsample(src: texture_2d<f32>, s: sampler, uv: vec2f, texel: vec2f) -> vec3f {
  let a = textureSampleLevel(src, s, uv + texel * vec2f(-2.0, -2.0), 0.0).rgb;
  let b = textureSampleLevel(src, s, uv + texel * vec2f(0.0, -2.0), 0.0).rgb;
  let c = textureSampleLevel(src, s, uv + texel * vec2f(2.0, -2.0), 0.0).rgb;
  let d = textureSampleLevel(src, s, uv + texel * vec2f(-2.0, 0.0), 0.0).rgb;
  let e = textureSampleLevel(src, s, uv, 0.0).rgb;
  let f = textureSampleLevel(src, s, uv + texel * vec2f(2.0, 0.0), 0.0).rgb;
  let g = textureSampleLevel(src, s, uv + texel * vec2f(-2.0, 2.0), 0.0).rgb;
  let h = textureSampleLevel(src, s, uv + texel * vec2f(0.0, 2.0), 0.0).rgb;
  let i = textureSampleLevel(src, s, uv + texel * vec2f(2.0, 2.0), 0.0).rgb;
  let j = textureSampleLevel(src, s, uv + texel * vec2f(-1.0, -1.0), 0.0).rgb;
  let k = textureSampleLevel(src, s, uv + texel * vec2f(1.0, -1.0), 0.0).rgb;
  let l = textureSampleLevel(src, s, uv + texel * vec2f(-1.0, 1.0), 0.0).rgb;
  let m = textureSampleLevel(src, s, uv + texel * vec2f(1.0, 1.0), 0.0).rgb;
  return e * 0.125 + (a + c + g + i) * 0.03125 + (b + d + f + h) * 0.0625 + (j + k + l + m) * 0.125;
}

// A nine-tap tent over `src` (the level below), `radius` texels wide.
export fn bloomUpsample(src: texture_2d<f32>, s: sampler, uv: vec2f, texel: vec2f, radius: f32) -> vec3f {
  let r = texel * radius;
  var sum = textureSampleLevel(src, s, uv, 0.0).rgb * 4.0;
  sum += (textureSampleLevel(src, s, uv + vec2f(-r.x, 0.0), 0.0).rgb
    + textureSampleLevel(src, s, uv + vec2f(r.x, 0.0), 0.0).rgb
    + textureSampleLevel(src, s, uv + vec2f(0.0, -r.y), 0.0).rgb
    + textureSampleLevel(src, s, uv + vec2f(0.0, r.y), 0.0).rgb) * 2.0;
  sum += textureSampleLevel(src, s, uv - r, 0.0).rgb
    + textureSampleLevel(src, s, uv + r, 0.0).rgb
    + textureSampleLevel(src, s, uv + vec2f(r.x, -r.y), 0.0).rgb
    + textureSampleLevel(src, s, uv + vec2f(-r.x, r.y), 0.0).rgb;
  return sum / 16.0;
}

// Lays a bloom over a display-referred colour as a screen blend, so it
// lifts darks more than lights and never clips.
export fn bloomScreen(color: vec3f, glow: vec3f) -> vec3f {
  return 1.0 - (1.0 - clamp(color, vec3f(0.0), vec3f(1.0))) * (1.0 - clamp(glow, vec3f(0.0), vec3f(1.0)));
}

