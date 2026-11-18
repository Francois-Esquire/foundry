
export struct MapFrame {
  origin: vec2f,
  texel: f32,
  resolution: u32,
}

export fn texelCenter(frame: MapFrame, texel: vec2u) -> vec2f {
  return frame.origin + (vec2f(texel) + 0.5) * frame.texel;
}

export fn ease(start: f32, end: f32, x: f32) -> f32 {
  if (end <= start) {
    return select(0.0, 1.0, x >= start);
  }
  return smoothstep(start, end, x);
}

export fn squareUv(p: vec2f, origin: vec2f, side: f32) -> vec2f {
  return (p - origin) / side;
}

export fn pastSquare(uv: vec2f) -> bool {
  return any(uv < vec2f(0.0)) || any(uv > vec2f(1.0));
}

const FAR_FADE_TEXELS = 6.0;

export fn farShare(uv: vec2f, farTexel: f32) -> f32 {
  let reach = FAR_FADE_TEXELS * farTexel;
  let x = ease(0.0, reach, uv.x) * ease(0.0, reach, 1.0 - uv.x);
  let y = ease(0.0, reach, uv.y) * ease(0.0, reach, 1.0 - uv.y);
  return 1.0 - x * y;
}
