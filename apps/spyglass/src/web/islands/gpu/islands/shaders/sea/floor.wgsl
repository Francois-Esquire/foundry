
const BAND_HOLD = 0.35;

export fn bandColor(bands: array<vec4f, 6>, depth: f32) -> vec3f {
  var b = bands;
  let d = log2(1.0 + max(depth, 0.0));
  var color = b[0].rgb;
  for (var i = 1u; i < 6u; i++) {
    let start = log2(1.0 + b[i - 1u].w);
    let end = log2(1.0 + b[i].w);
    color = mix(color, b[i].rgb, smoothstep(mix(start, end, BAND_HOLD), end, d));
  }
  return color;
}

export struct FloorPaint {
  sand: vec3f,
  tint: f32,
  silt: vec3f,
  siltDepth: f32,
  bands: array<vec4f, 6>,
}

const WET_SAND = vec3f(0.86, 0.88, 0.8);

export fn floorPaint(floor: FloorPaint, height: f32) -> vec3f {
  if (height >= 0.0) {
    return floor.sand;
  }
  let depth = -height;
  let ground = mix(floor.sand * WET_SAND, floor.silt, smoothstep(0.0, floor.siltDepth, depth));
  return mix(ground, bandColor(floor.bands, depth), floor.tint);
}
