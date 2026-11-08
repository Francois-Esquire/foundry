// Smooth reads of a mipped map. Pure: the caller passes its own texture and
// sampler (a linear one).

// Channel r of `map` at uv from mip `level`, through a cubic B-spline so the
// result is smooth to the second derivative, where bilinear reads of a
// coarse level crease at every texel: four bilinear taps placed to weigh
// sixteen texels.
export fn splineLevel(map: texture_2d<f32>, linear: sampler, uv: vec2f, level: u32) -> f32 {
  let size = vec2f(textureDimensions(map, level));
  let st = uv * size - 0.5;
  let i = floor(st);
  let f = st - i;
  let f2 = f * f;
  let f3 = f2 * f;
  let w0 = (1.0 - 3.0 * f + 3.0 * f2 - f3) / 6.0;
  let w1 = (4.0 - 6.0 * f2 + 3.0 * f3) / 6.0;
  let w2 = (1.0 + 3.0 * f + 3.0 * f2 - 3.0 * f3) / 6.0;
  let w3 = f3 / 6.0;
  let g0 = w0 + w1;
  let g1 = w2 + w3;
  let h0 = (i - 0.5 + w1 / g0) / size;
  let h1 = (i + 1.5 + w3 / g1) / size;
  let lod = f32(level);
  return g0.y * (g0.x * textureSampleLevel(map, linear, vec2f(h0.x, h0.y), lod).r
      + g1.x * textureSampleLevel(map, linear, vec2f(h1.x, h0.y), lod).r)
    + g1.y * (g0.x * textureSampleLevel(map, linear, vec2f(h0.x, h1.y), lod).r
      + g1.x * textureSampleLevel(map, linear, vec2f(h1.x, h1.y), lod).r);
}
