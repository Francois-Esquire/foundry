// FXAA (Lottes' console variant): finds an edge from the luma of the four
// diagonal neighbours, and blurs along it, never across, by up to SPAN_MAX
// texels; where the longer blur strays outside the neighbourhood's luma it
// keeps the shorter one. Reads a display-referred image (luma is taken on
// it as stored). The entry shader owns the texture and the sampler.

// Luma contrast below which a pixel is left alone: flat areas stay sharp.
const EDGE_MIN = 1.0 / 24.0;
// How far the blur may run along an edge, texels, and how short edges
// are kept from over-reaching.
const SPAN_MAX = 8.0;
const REDUCE_MUL = 1.0 / 8.0;
const REDUCE_MIN = 1.0 / 128.0;

fn fxaaLuma(c: vec3f) -> f32 {
  return dot(c, vec3f(0.299, 0.587, 0.114));
}

// The anti-aliased colour at `uv` of `src`, `texel` one texel in uv.
export fn fxaa(src: texture_2d<f32>, s: sampler, uv: vec2f, texel: vec2f) -> vec3f {
  let rgbM = textureSampleLevel(src, s, uv, 0.0).rgb;
  let nw = fxaaLuma(textureSampleLevel(src, s, uv + vec2f(-1.0, -1.0) * texel, 0.0).rgb);
  let ne = fxaaLuma(textureSampleLevel(src, s, uv + vec2f(1.0, -1.0) * texel, 0.0).rgb);
  let sw = fxaaLuma(textureSampleLevel(src, s, uv + vec2f(-1.0, 1.0) * texel, 0.0).rgb);
  let se = fxaaLuma(textureSampleLevel(src, s, uv + vec2f(1.0, 1.0) * texel, 0.0).rgb);
  let m = fxaaLuma(rgbM);
  let lumaMin = min(m, min(min(nw, ne), min(sw, se)));
  let lumaMax = max(m, max(max(nw, ne), max(sw, se)));
  if (lumaMax - lumaMin < max(EDGE_MIN, lumaMax * 0.125)) {
    return rgbM;
  }
  var dir = vec2f(-((nw + ne) - (sw + se)), (nw + sw) - (ne + se));
  let reduce = max((nw + ne + sw + se) * 0.25 * REDUCE_MUL, REDUCE_MIN);
  let scale = 1.0 / (min(abs(dir.x), abs(dir.y)) + reduce);
  dir = clamp(dir * scale, vec2f(-SPAN_MAX), vec2f(SPAN_MAX)) * texel;
  let near = 0.5 * (textureSampleLevel(src, s, uv + dir * (1.0 / 3.0 - 0.5), 0.0).rgb
    + textureSampleLevel(src, s, uv + dir * (2.0 / 3.0 - 0.5), 0.0).rgb);
  let far = 0.5 * near + 0.25 * (textureSampleLevel(src, s, uv - 0.5 * dir, 0.0).rgb
    + textureSampleLevel(src, s, uv + 0.5 * dir, 0.0).rgb);
  let lumaFar = fxaaLuma(far);
  return select(far, near, lumaFar < lumaMin || lumaFar > lumaMax);
}
