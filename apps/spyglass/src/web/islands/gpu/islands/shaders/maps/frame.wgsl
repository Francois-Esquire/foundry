// The grid every map shares: one square frame over the chart, `resolution`
// texels a side, texel (i, j) centred at origin + (i + 0.5, j + 0.5) * texel.
// Pure: the entry shaders own the bindings.

export struct MapFrame {
  origin: vec2f,
  texel: f32,
  resolution: u32,
}

// The chart point at a texel's centre.
export fn texelCenter(frame: MapFrame, texel: vec2u) -> vec2f {
  return frame.origin + (vec2f(texel) + 0.5) * frame.texel;
}

// A smoothstep that tolerates a zero-width edge: with `end <= start` it is a
// hard step at `start`, where smoothstep itself is undefined.
export fn ease(start: f32, end: f32, x: f32) -> f32 {
  if (end <= start) {
    return select(0.0, 1.0, x >= start);
  }
  return smoothstep(start, end, x);
}

// Where chart point p lies in the square `side` across from `origin`, as a
// uv: 0 to 1 within it.
export fn squareUv(p: vec2f, origin: vec2f, side: f32) -> vec2f {
  return (p - origin) / side;
}

// Whether uv `uv` lies past its square: past the frame's maps, the open
// sea's floor (maps/seabed.wgsl).
export fn pastSquare(uv: vec2f) -> bool {
  return any(uv < vec2f(0.0)) || any(uv > vec2f(1.0));
}

// The far floor's texels the frame's floor gives way to it over, in from
// the frame's edge: the frame's maps hold the floor far finer than the
// seabed map, so rather than stop at the edge their detail fades into its.
const FAR_FADE_TEXELS = 6.0;

// How much the open sea's far floor (maps/seabed.wgsl) shows at the
// frame's maps' uv `uv`, 0–1: 0 well inside the frame, easing up to 1 at
// its edge and past it. `farTexel` is the seabed map's texel as a share of
// the frame's side. Eased on each side and multiplied, so the corners
// round off with no crease along their diagonals.
export fn farShare(uv: vec2f, farTexel: f32) -> f32 {
  let reach = FAR_FADE_TEXELS * farTexel;
  let x = ease(0.0, reach, uv.x) * ease(0.0, reach, 1.0 - uv.x);
  let y = ease(0.0, reach, uv.y) * ease(0.0, reach, 1.0 - uv.y);
  return 1.0 - x * y;
}
