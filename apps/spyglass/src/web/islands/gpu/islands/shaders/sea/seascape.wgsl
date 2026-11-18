import { planarFbm, planarHash, planarHash2, planarNoise, planarRidged } from "../../../../shaders/noise/planar.wgsl";
import { terrace } from "../../../../shaders/terrain/shaping.wgsl";
import { ease, MapFrame } from "../maps/frame.wgsl";

export struct Seascape {
  basins: f32,
  scale: f32,
  veer: f32,
  step: f32,
  descent: f32,
  calm: f32,
  rise: f32,
  radius: f32,
  sills: f32,
  hills: f32,
  canyons: f32,
  faults: f32,
  pits: f32,
  seed: u32,
}

const WARP_SALT = 740u;
const BASIN_SALT = 746u;
const TROUGH_SALT = 750u;
const HILL_SALT = 753u;
const FAULT_SALT = 755u;
const CANYON_SALT = 757u;
const CANYON_MEANDER_SALT = 736u;
const PIT_SALT = 759u;
const PIT_PLACE_SALT = 738u;
const SWING_SALT = 762u;
const SILL_SALT = 764u;

const WARP_CELL = 2.5;
const WARP_REACH = 0.9;
const BASIN = 0.55;
const TROUGH_CELL = 1.6;
const TROUGH = 0.6;
const TROUGH_NARROW = 3.0;
const RISER = 0.35;
const TREAD_TILT = 0.1;

const SWING = 0.35;
const SWING_CELL = 1.4;
const SILL_CELL = 1.1;
const SILL_NARROW = 2.0;

const HILL_CELL = 0.3;

const FAULT_CELL = 2.2;
const FAULT_EDGE = 0.04;
const FAULT_OFFSET = vec2f(9.4, 2.8);

const COAST_BLUR = 0.08;
const CANYON_CLEAR = vec2f(0.85, 0.97);
const CANYON_CELL = 0.7;
const CANYON_WIDTH = 0.1;
const CANYON_WIDEN = 0.06;
const CANYON_SLOPE = 1.5;
const CANYON_MEANDER = 0.35;
const CANYON_RUN = 1.1;
const CANYON_DEEPEN = 0.35;

const PIT_CELL = 0.8;
const PIT_RADIUS = vec2f(0.08, 0.22);

const PIT_DEPTH = vec2f(0.3, 0.8);


export struct Coast {
  distance: f32,
  fall: vec2f,
}

const COAST_POINTS = 16u;

struct SoftLeast {
  least: f32,
  weight: f32,
  total: f32,
  way: vec2f,
  run: f32,
}

fn foldPoint(acc: SoftLeast, p: vec2f, at: vec2f, coast: f32, soft: f32) -> SoftLeast {
  let off = p - at;
  let run = length(off);
  let total = coast + run;
  var next = acc;
  var weight = 1.0;
  if (total < acc.least) {
    let scale = exp((total - acc.least) / soft);
    next.least = total;
    next.weight *= scale;
    next.total *= scale;
    next.way *= scale;
    next.run *= scale;
  } else {
    weight = exp((acc.least - total) / soft);
  }
  next.weight += weight;
  next.total += total * weight;
  next.way += off * weight;
  next.run += run * weight;
  return next;
}

fn coastBlur(s: Seascape) -> f32 {
  return COAST_BLUR * s.scale;
}

export fn openCoast(distance: texture_2d<f32>, grid: MapFrame, s: Seascape, p: vec2f) -> Coast {
  let levels = textureNumLevels(distance);
  let side = grid.texel * f32(grid.resolution);
  let wanted = u32(round(log2(f32(grid.resolution) / f32(COAST_POINTS))));
  let lod = min(wanted, levels - 1u);
  let count = textureDimensions(distance, lod);
  let spacing = side / f32(count.x);
  let soft = max(spacing, coastBlur(s));
  var acc = SoftLeast(1e30, 0.0, 0.0, vec2f(0.0), 0.0);
  for (var j = 0u; j < count.y; j++) {
    for (var i = 0u; i < count.x; i++) {
      let at = grid.origin + (vec2f(f32(i), f32(j)) + 0.5) * spacing;
      let coast = textureLoad(distance, vec2u(i, j), lod).r;
      acc = foldPoint(acc, p, at, coast, soft);
    }
  }
  let fall = acc.way / max(acc.run, 1e-3);
  return Coast(acc.total / acc.weight - 0.5 * soft, fall);
}


fn canyonsAt(s: Seascape, p: vec2f, out: f32, fall: vec2f) -> f32 {
  let clear = length(fall);
  let shown = ease(CANYON_CLEAR.x, CANYON_CLEAR.y, clear);
  if (s.canyons <= 0.0 || shown <= 0.0) {
    return 0.0;
  }
  let way = fall / clear;
  let across = vec2f(-way.y, way.x);
  let cell = CANYON_CELL * s.scale;
  let head = p - out * way;
  let fan = (s.radius + s.calm + out) / (s.radius + s.calm);
  let run = vec2f(out / (CANYON_RUN * s.scale), 0.0);
  let meander = planarFbm(run + head / cell, 2, 0.5, s.seed, CANYON_MEANDER_SALT);
  let aside = CANYON_MEANDER * s.scale * meander;
  let wandered = head + across * (aside / fan);
  let field = planarNoise(wandered / cell, s.seed, CANYON_SALT);
  let offAxis = abs(field) * cell / CANYON_SLOPE * fan;
  let width = CANYON_WIDTH * s.scale + CANYON_WIDEN * out;
  let cut = 1.0 - smoothstep(0.0, 1.0, offAxis / width);
  let deepen = smoothstep(0.0, CANYON_DEEPEN * s.scale, out);
  return s.canyons * cut * deepen * shown;
}

fn pitsAt(s: Seascape, q: vec2f) -> f32 {
  if (s.pits <= 0.0) {
    return 0.0;
  }
  let cellAt = q / PIT_CELL;
  let home = vec2i(floor(cellAt));
  var deepest = 0.0;
  for (var j = -1; j <= 1; j++) {
    for (var i = -1; i <= 1; i++) {
      let cell = home + vec2i(i, j);
      if (planarHash(cell, s.seed, PIT_SALT) >= s.pits) {
        continue;
      }
      let centre = vec2f(cell) + 0.25 + 0.5 * planarHash2(cell, s.seed, PIT_PLACE_SALT);
      let size = planarHash2(cell, s.seed, PIT_PLACE_SALT + 1u);
      let r = length(cellAt - centre) / mix(PIT_RADIUS.x, PIT_RADIUS.y, size.x);
      if (r >= 1.0) {
        continue;
      }
      let wall = 1.0 - r * r;
      deepest = max(deepest, mix(PIT_DEPTH.x, PIT_DEPTH.y, size.y) * wall * wall);
    }
  }
  return deepest * s.basins;
}

fn fallAt(s: Seascape, w: vec2f, out: f32) -> f32 {
  let swingIn = smoothstep(0.0, s.scale, out);
  let swing = planarFbm(w / SWING_CELL, 2, 0.5, s.seed, SWING_SALT);
  let swung = out + SWING * s.scale * s.veer * swingIn * swing;
  let crest = planarRidged(w / SILL_CELL, 2, 0.5, s.seed, SILL_SALT);
  let held = s.sills * pow(crest, SILL_NARROW);
  return s.descent * max(swung, 0.0) * (1.0 - held);
}

export fn seascapeSink(s: Seascape, p: vec2f, coast: f32, fall: vec2f) -> f32 {
  let grown = ease(s.calm, s.calm + s.rise, coast);
  if (grown <= 0.0) {
    return 0.0;
  }
  let out = max(coast - s.calm, 0.0);
  let q = p / s.scale;
  let warpAt = q / WARP_CELL;
  let warp = vec2f(
    planarFbm(warpAt, 2, 0.5, s.seed, WARP_SALT),
    planarFbm(warpAt + vec2f(5.2, 1.3), 2, 0.5, s.seed, WARP_SALT + 3u),
  );
  let w = q + warp * (WARP_REACH * s.veer);
  let basin = BASIN * saturate(0.5 + 0.8 * planarFbm(w, 2, 0.4, s.seed, BASIN_SALT));
  let wind = 1.0 - abs(planarFbm(w / TROUGH_CELL, 2, 0.45, s.seed, TROUGH_SALT));
  let trough = TROUGH * pow(wind, TROUGH_NARROW);
  let hills = s.hills * (1.0 - planarRidged(w / HILL_CELL, 2, 0.5, s.seed, HILL_SALT));
  let faultLine = planarFbm(w / FAULT_CELL + FAULT_OFFSET, 2, 0.5, s.seed, FAULT_SALT);
  let fault = s.faults * smoothstep(-FAULT_EDGE, FAULT_EDGE, faultLine);
  let landform = (basin + trough + hills) * s.basins + pitsAt(s, w);
  let canyons = canyonsAt(s, p, out, fall);
  return grown * (fallAt(s, w, out) + landform + fault + canyons);
}

export fn sunkGround(s: Seascape, ground: f32, sink: f32, floorDepth: f32) -> f32 {
  let stepped = -steppedFloor(s, sink, floorDepth);
  return ground - max(stepped - floorDepth, 0.0);
}

export fn steppedFloor(s: Seascape, sink: f32, floorDepth: f32) -> f32 {
  if (sink <= 0.0) {
    return -floorDepth;
  }
  let depth = floorDepth + sink;
  if (s.step <= 1.0 || floorDepth <= 0.0) {
    return -depth;
  }
  let steps = log(depth / floorDepth) / log(s.step);
  return -floorDepth * pow(s.step, terrace(steps, RISER, TREAD_TILT));
}
