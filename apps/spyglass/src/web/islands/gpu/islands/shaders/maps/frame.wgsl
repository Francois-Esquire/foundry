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
