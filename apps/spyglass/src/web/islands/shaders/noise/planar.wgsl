
fn pcg(v: u32) -> u32 {
  let state = v * 747796405u + 2891336453u;
  let word = ((state >> ((state >> 28u) + 4u)) ^ state) * 277803737u;
  return (word >> 22u) ^ word;
}

export fn planarHash(cell: vec2i, seed: u32, salt: u32) -> f32 {
  let h = pcg(bitcast<u32>(cell.x) ^ pcg(bitcast<u32>(cell.y) ^ pcg(seed ^ (salt * 2654435761u))));
  return f32(h >> 8u) / 16777216.0;
}

export fn planarHash2(cell: vec2i, seed: u32, salt: u32) -> vec2f {
  return vec2f(planarHash(cell, seed, salt), planarHash(cell, seed, salt + 7919u));
}

export fn planarNoise(p: vec2f, seed: u32, salt: u32) -> f32 {
  let cell = vec2i(floor(p));
  let f = fract(p);
  let u = f * f * f * (f * (f * 6.0 - 15.0) + 10.0);
  var corners: array<f32, 4>;
  for (var i = 0; i < 4; i++) {
    let o = vec2i(i & 1, i >> 1);
    let angle = planarHash(cell + o, seed, salt) * 6.2831853;
    corners[i] = dot(vec2f(cos(angle), sin(angle)), f - vec2f(o));
  }
  return mix(mix(corners[0], corners[1], u.x), mix(corners[2], corners[3], u.x), u.y) * 1.41;
}

const OCTAVE_TURN = mat2x2f(0.8, 0.6, -0.6, 0.8);

export fn planarFbm(p: vec2f, octaves: i32, gain: f32, seed: u32, salt: u32) -> f32 {
  var q = p;
  var amplitude = 1.0;
  var total = 0.0;
  var norm = 0.0;
  for (var i = 0; i < octaves; i++) {
    total += planarNoise(q, seed, salt + u32(i)) * amplitude;
    norm += amplitude;
    amplitude *= gain;
    q = OCTAVE_TURN * q * 2.03;
  }
  return total / max(norm, 1e-6);
}

export fn planarRidged(p: vec2f, octaves: i32, gain: f32, seed: u32, salt: u32) -> f32 {
  var q = p;
  var amplitude = 0.5;
  var weight = 1.0;
  var total = 0.0;
  var norm = 0.0;
  for (var i = 0; i < octaves; i++) {
    var ridge = 1.0 - abs(planarNoise(q, seed, salt + u32(i)));
    ridge = ridge * ridge * weight;
    weight = clamp(ridge * 2.0, 0.0, 1.0);
    total += ridge * amplitude;
    norm += amplitude;
    amplitude *= gain;
    q = OCTAVE_TURN * q * 2.03;
  }
  return total / max(norm, 1e-6);
}
