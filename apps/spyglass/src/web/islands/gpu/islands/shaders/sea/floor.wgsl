// The sea's colours: the chart's bands by depth, which the water shows,
// and the floor's own colour before light, sand going to silt and tinted by
// the same bands. Pure: the paint map's kernel (maps/paint.wgsl) paints the
// floor and the composite (water.wgsl) colours the water.

// Each band holds this share of the log-depth step to the next before it
// turns, so a level reads as one colour, not a gradient.
const BAND_HOLD = 0.35;

// The sea's colour at a depth: piecewise between the bands (rgb, and w the
// depth each is reached at), in log depth so the shallow bands get as much
// room as the deep ones.
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
  // How far the floor's colour takes its band's, 0–1.
  tint: f32,
  silt: vec3f,
  // Where the floor is silt.
  siltDepth: f32,
  bands: array<vec4f, 6>,
}

// Wet sand under water is a little greener and darker than dry.
const WET_SAND = vec3f(0.86, 0.88, 0.8);

// The floor's colour at a height: sand above the water, then wet sand
// going to silt with depth, pulled toward the band colour the water shows.
export fn floorPaint(floor: FloorPaint, height: f32) -> vec3f {
  if (height >= 0.0) {
    return floor.sand;
  }
  let depth = -height;
  let ground = mix(floor.sand * WET_SAND, floor.silt, smoothstep(0.0, floor.siltDepth, depth));
  return mix(ground, bandColor(floor.bands, depth), floor.tint);
}
