// Height-shaping operators for heightfields: smooth unions and terraces.

// Polynomial smooth maximum: max(a, b) with the corner rounded over a
// width of k. k <= 0 is a hard max.
export fn smoothMax(a: f32, b: f32, k: f32) -> f32 {
  if (k <= 0.0) { return max(a, b); }
  let h = max(k - abs(a - b), 0.0) / k;
  return max(a, b) + h * h * k * 0.25;
}

export fn smoothMin(a: f32, b: f32, k: f32) -> f32 {
  return -smoothMax(-a, -b, k);
}

// A staircase over x in units of one step: flat treads, and a riser that
// spends `riser` (0–1) of each step climbing. `tilt` (0–1) lets the treads
// keep that much of the original slope. terrace(0) = 0, and it is
// continuous and monotonic for any riser > 0.
export fn terrace(x: f32, riser: f32, tilt: f32) -> f32 {
  let k = floor(x);
  let f = x - k;
  let w = clamp(riser, 0.001, 1.0);
  let climb = smoothstep(1.0 - w, 1.0, f);
  return k + mix(climb, f, clamp(tilt, 0.0, 1.0));
}

// A terrace step whose character runs from a soft ramp to a cliff.
// hardness 1 is `terrace` with the given riser and tilt: a crisp riser and
// flat treads. hardness 0 spends most of the step climbing and keeps most
// of the slope on the tread: the layer still shows as a gentle swell, but
// it's smoothed over rather than a cliff. Hardness may change from step to
// step (pick it from floor(x)) and drift smoothly with position: every step
// still starts at k and ends at k + 1, so the result stays continuous and
// monotonic.
export fn softTerrace(x: f32, riser: f32, tilt: f32, hardness: f32) -> f32 {
  let h = clamp(hardness, 0.0, 1.0);
  return terrace(x, mix(max(riser, 0.9), riser, h), mix(max(tilt, 0.6), tilt, h));
}
