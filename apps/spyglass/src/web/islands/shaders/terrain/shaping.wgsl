
export fn smoothMax(a: f32, b: f32, k: f32) -> f32 {
  if (k <= 0.0) { return max(a, b); }
  let h = max(k - abs(a - b), 0.0) / k;
  return max(a, b) + h * h * k * 0.25;
}

export fn smoothMin(a: f32, b: f32, k: f32) -> f32 {
  return -smoothMax(-a, -b, k);
}

export fn terrace(x: f32, riser: f32, tilt: f32) -> f32 {
  let k = floor(x);
  let f = x - k;
  let w = clamp(riser, 0.001, 1.0);
  let climb = smoothstep(1.0 - w, 1.0, f);
  return k + mix(climb, f, clamp(tilt, 0.0, 1.0));
}

export fn softTerrace(x: f32, riser: f32, tilt: f32, hardness: f32) -> f32 {
  let h = clamp(hardness, 0.0, 1.0);
  return terrace(x, mix(max(riser, 0.9), riser, h), mix(max(tilt, 0.6), tilt, h));
}
