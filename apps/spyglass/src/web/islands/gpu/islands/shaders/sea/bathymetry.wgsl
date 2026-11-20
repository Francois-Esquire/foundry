import { planarFbm, planarHash, planarRidged } from "../../../../shaders/noise/planar.wgsl";
import { smoothMin } from "../../../../shaders/terrain/shaping.wgsl";
import { ease } from "../maps/frame.wgsl";

export struct Bathymetry {
  floorDepth: f32,
  slopeWidth: f32,
  texel: f32,
}

export struct Platform {
  base: f32,
  margin: f32,
  merge: f32,
  ragged: f32,
  scarp: f32,
  deepRings: u32,
}

export struct Beach {
  width: f32,
  height: f32,
  sandDepth: f32,
  cliffDepth: f32,
  cliff: f32,
  smallSand: f32,
  smallSize: f32,
  cove: f32,
  coveDepth: f32,
}

export struct Banks {
  top: f32,
  step: f32,
  taper: f32,
  run: f32,
  spread: f32,
  hull: f32,
  bottomReach: f32,
  topReach: f32,
  slope: f32,
  minRiser: f32,
  wander: f32,
  lift: f32,
  liftTread: f32,
  undulation: f32,
  undulationLength: f32,
  undulationWay: vec2f,
  undulationShift: f32,
  undulationSteps: f32,
  undulationBend: f32,
  bridge: f32,
  moat: f32,
  moatAmount: f32,
  levels: u32,
  islandCount: u32,
  bankCount: u32,
}



const SMOOTHING = 0.125;
const SMOOTHING_SPREAD = 0.6;

export fn hasBanks(banks: Banks) -> bool {
  return banks.run > 0.0 && banks.bankCount > 0u;
}

export fn smoothingScale(beach: Beach, banks: Banks) -> f32 {
  let reach = select(0.0, SMOOTHING_SPREAD * banks.spread, hasBanks(banks));
  return max(reach, beach.width) * SMOOTHING;
}

export fn nearDistance(d: f32, local: f32, smoothed: f32, scale: f32) -> f32 {
  let near = mix(d, local, ease(0.0, 0.5 * scale, d));
  return mix(near, smoothed, ease(0.0, 2.0 * scale, d));
}

export fn islandDistance(smoothed: f32, own: f32, others: f32, blend: f32) -> f32 {
  return mix(smoothed, own, ease(-blend, blend, own - others));
}


export fn mergeTerm(platform: Platform, delta: f32, least: f32) -> f32 {
  return exp(-(delta - least) / max(platform.merge, 1e-3));
}

export fn mergedDistance(platform: Platform, least: f32, terms: f32) -> f32 {
  return least - max(platform.merge, 1e-3) * log(max(terms, 1e-30));
}

const LOBE_CELL = 1.6;
const NOTCH_CELL = 0.5;
const LOBE_SALT = 720u;
const NOTCH_SALT = 723u;
const NOTCH_SHARE = 0.4;
const LEAST_OUTLINE = 0.2;

fn spreadOf(banks: Banks) -> f32 {
  return select(0.0, banks.spread, hasBanks(banks));
}

fn outlineCell(platform: Platform, banks: Banks) -> f32 {
  return max(spreadOf(banks) + platform.margin, 1.0);
}

export fn platformLobes(platform: Platform, banks: Banks, p: vec2f) -> f32 {
  if (platform.ragged <= 0.0) {
    return 0.0;
  }
  let lobes = planarFbm(p / (outlineCell(platform, banks) * LOBE_CELL), 3, 0.5, 1u, LOBE_SALT);
  return spreadOf(banks) * platform.ragged * lobes;
}

export fn platformReach(platform: Platform, banks: Banks, p: vec2f) -> f32 {
  let reach = spreadOf(banks);
  if (platform.ragged <= 0.0 || reach <= 0.0) {
    return reach;
  }
  let notches = planarRidged(p / (outlineCell(platform, banks) * NOTCH_CELL), 3, 0.5, 1u, NOTCH_SALT);
  let outline = reach + platformLobes(platform, banks, p) - reach * platform.ragged * NOTCH_SHARE * notches;
  return max(outline, reach * LEAST_OUTLINE);
}


export fn topSilhouette(delta: f32, hull: f32, radius: f32) -> f32 {
  return smoothMin(delta, hull, 0.5 * radius);
}

export fn bottomSilhouette(banks: Banks, top: f32, outline: f32, platformReach: f32, reach: f32, rings: u32) -> f32 {
  let bottom = max(outline, top - banks.bottomReach * platformReach * reach);
  return min(bottom, top - f32(rings) * banks.run);
}

export fn treadOf(top: f32, bottom: f32, rings: u32) -> f32 {
  return (top - bottom) / f32(max(rings, 1u));
}

export fn ringPast(top: f32, tread: f32, fromTop: u32) -> f32 {
  return top - f32(fromTop) * tread;
}

const SCARP_WIDTH = 0.08;

export fn riserWidth(banks: Banks, run: f32) -> f32 {
  return max(banks.slope * run, banks.minRiser);
}

const WANDER_ROOM = 0.95;

const MAX_DEEP_RINGS = 32u;
const DEEP_JITTER = 0.2;
const DEEP_SPACING_SALT = 729u;
const DEEP_WANDER_SALT = 730u;
const DEEP_WANDER_CELL = 3.0;

fn deepWeight(banks: Banks, ring: u32, rings: u32) -> f32 {
  let crowd = pow(max(banks.taper, 1e-3), f32(rings - ring));
  let jitter = 2.0 * planarHash(vec2i(i32(ring), 0), 1u, DEEP_SPACING_SALT) - 1.0;
  return crowd * (1.0 + DEEP_JITTER * jitter);
}

fn deepSteps(banks: Banks, p: vec2f, u: f32, length: f32, rings: u32) -> f32 {
  if (u <= 0.0) {
    return 0.0;
  }
  var total = 0.0;
  for (var k = 0u; k <= rings; k++) {
    total += deepWeight(banks, k, rings);
  }
  let scale = length / total;
  var steps = 0.0;
  var edge = 0.0;
  var run = deepWeight(banks, 0u, rings) * scale;
  for (var k = 0u; k <= rings; k++) {
    edge += run;
    var outer = run;
    if (k < rings) {
      outer = deepWeight(banks, k + 1u, rings) * scale;
    }
    let riser = riserWidth(banks, run);
    let room = max(0.5 * (min(run, outer) - max(riser, riserWidth(banks, outer))), 0.0);
    let stray = min(banks.wander * run, WANDER_ROOM * room);
    var at = u - edge;
    if (stray > 0.0 && abs(at) < stray + 0.5 * riser) {
      let offset = vec2f(f32(k) * 5.17, f32(k) * 3.29);
      let cell = max(run * DEEP_WANDER_CELL, 1.0);
      at -= stray * clamp(planarFbm(p / cell + offset, 3, 0.5, 1u, DEEP_WANDER_SALT), -1.0, 1.0);
    }
    steps += ease(-0.5 * riser, 0.5 * riser, at);
    run = outer;
  }
  return steps;
}

export fn slopeEnd(bed: Bathymetry) -> f32 {
  let scarpWidth = max(SCARP_WIDTH * bed.slopeWidth, 3.0 * bed.texel);
  return bed.slopeWidth + 0.5 * scarpWidth;
}

const OPEN_RISE = 0.6;

export fn openShareOf(bed: Bathymetry, past: f32) -> f32 {
  let end = slopeEnd(bed);
  return ease(end, openWhole(bed), past);
}

export fn openWhole(bed: Bathymetry) -> f32 {
  return slopeEnd(bed) + OPEN_RISE * bed.slopeWidth;
}

const ON_DEEP = 1e-4;

export fn deepShareOf(bed: Bathymetry, h: f32) -> f32 {
  let deep = bed.floorDepth;
  return 1.0 - ease(0.0, ON_DEEP * deep, h + deep);
}

export fn platformHeight(bed: Bathymetry, platform: Platform, banks: Banks, p: vec2f, past: f32) -> f32 {
  let fall = max(bed.floorDepth - platform.base, 0.0);
  let scarpWidth = max(SCARP_WIDTH * bed.slopeWidth, 3.0 * bed.texel);
  let scarp = platform.scarp * ease(0.0, scarpWidth, past);
  let foot = 0.5 * scarpWidth;
  let rings = min(platform.deepRings, MAX_DEEP_RINGS);
  var slope = 0.0;
  if (rings == 0u) {
    slope = ease(foot, foot + bed.slopeWidth, past);
  } else {
    let length = max(bed.slopeWidth - foot, bed.texel);
    slope = deepSteps(banks, p, past - scarpWidth, length, rings) / f32(rings + 1u);
  }
  return -platform.base - fall * (scarp + (1.0 - platform.scarp) * slope);
}


export fn levelRise(banks: Banks, level: u32) -> f32 {
  let count = f32(level + 1u);
  if (banks.taper >= 1.0) {
    return banks.step * count;
  }
  return banks.step * (1.0 - pow(banks.taper, count)) / (1.0 - banks.taper);
}

export fn liftOf(banks: Banks, tread: f32) -> f32 {
  return banks.lift * ease(0.0, banks.liftTread, tread);
}

export fn levelHeight(platform: Platform, banks: Banks, level: u32, lift: f32) -> f32 {
  let rise = levelRise(banks, level);
  let whole = max(levelRise(banks, max(banks.levels, 1u) - 1u), 1e-3);
  return -platform.base + rise * (1.0 + lift * (1.0 - rise / whole));
}

const TERRACE_TURN = 0.6;
const TAU = 6.2831853;
const BEND_CELL = 2.5;
const PATCH_CELL = 3.0;
const UNDULATION_CALM = 0.15;
const BEND_SALT = 733u;
const PATCH_SALT = 735u;

fn undulationWave(banks: Banks, p: vec2f, place: f32) -> f32 {
  let q = p / banks.undulationLength;
  let bend = vec2f(
    planarFbm(q / BEND_CELL, 3, 0.5, 1u, BEND_SALT),
    planarFbm(q / BEND_CELL + vec2f(5.2, 1.3), 3, 0.5, 1u, BEND_SALT + 1u),
  ) * banks.undulationBend;
  let phase = dot(q + bend, banks.undulationWay) + place * banks.undulationShift;
  var wave = sin(TAU * phase);
  if (banks.undulationSteps > 0.0) {
    let x = 0.5 * (wave + 1.0) * banks.undulationSteps;
    let turn = smoothstep(0.5 - 0.5 * TERRACE_TURN, 0.5 + 0.5 * TERRACE_TURN, fract(x));
    wave = 2.0 * (floor(x) + turn) / banks.undulationSteps - 1.0;
  }
  let swell = smoothstep(-0.4, 0.4, planarFbm(q / PATCH_CELL, 2, 0.5, 1u, PATCH_SALT));
  return clamp(wave, -1.0, 1.0) * mix(UNDULATION_CALM, 1.0, swell);
}

fn undulates(banks: Banks) -> bool {
  return banks.undulation > 0.0 && banks.undulationLength > 0.0;
}

export fn undulationAt(banks: Banks, p: vec2f, level: u32) -> f32 {
  if (!undulates(banks) || level + 1u >= banks.levels) {
    return 0.0;
  }
  let own = levelRise(banks, level) - select(0.0, levelRise(banks, level - 1u), level > 0u);
  return banks.undulation * own * undulationWave(banks, p, f32(level));
}

export fn platformUndulation(banks: Banks, p: vec2f) -> f32 {
  if (!undulates(banks)) {
    return 0.0;
  }
  return banks.undulation * levelRise(banks, 0u) * undulationWave(banks, p, -1.0);
}

const WANDER_CELL = 0.3;
const WANDER_SALT = 726u;
const OUTER_WANDER = 0.4;

export fn wanderReach(banks: Banks, tread: f32, riser: f32, level: u32) -> f32 {
  let room = max(0.5 * (tread - riser), 0.0) * WANDER_ROOM;
  let place = f32(level + 1u) / f32(max(banks.levels, 1u));
  return min(banks.wander * tread, room) * mix(OUTER_WANDER, 1.0, place);
}

export fn wanderAt(banks: Banks, p: vec2f, bank: u32) -> f32 {
  let offset = vec2f(f32(bank) * 7.31, f32(bank) * 4.46);
  let cell = max(banks.spread * WANDER_CELL, 1.0);
  let noise = planarFbm(p / cell + offset, 3, 0.5, 1u, WANDER_SALT);
  return clamp(noise, -1.0, 1.0);
}

export fn plateCover(outside: f32, riser: f32) -> f32 {
  return 1.0 - ease(-0.5 * riser, 0.5 * riser, outside);
}

export fn moatKeep(banks: Banks, size: f32, delta: f32, riser: f32) -> f32 {
  let cut = banks.moat * size;
  let keep = ease(cut - 0.5 * riser, cut + 0.5 * riser, delta);
  return mix(1.0, keep, banks.moatAmount);
}

export fn plateOver(platformFloor: f32, height: f32, cover: f32) -> f32 {
  return mix(platformFloor, height, cover);
}

export fn shoreSteepness(beach: Beach, depth: f32) -> f32 {
  return ease(beach.sandDepth, beach.cliffDepth, depth);
}

export fn beachWidth(beach: Beach, size: f32, steep: f32) -> f32 {
  let sand = beach.width * (1.0 + beach.smallSand * (1.0 - ease(0.0, beach.smallSize, size)));
  return mix(sand, beach.cliff, steep);
}

fn fall(floor: f32, t: f32) -> f32 {
  let rest = 1.0 - saturate(t);
  return floor * (1.0 - rest * rest);
}

export fn shoreHeight(beach: Beach, floor: f32, top: f32, delta: f32, width: f32, steep: f32) -> f32 {
  var sand = fall(floor, top / max(width, 1e-3));
  if (top <= 0.0) {
    sand = beach.height * -top / max(max(delta, 0.0) - top, 1e-3);
  }
  sand = min(sand, coveHeight(beach, floor, delta, width));
  return mix(sand, fall(floor, delta / max(beach.cliff, 1e-3)), steep);
}

fn coveHeight(beach: Beach, floor: f32, delta: f32, width: f32) -> f32 {
  if (beach.cove <= 0.0) {
    return beach.height;
  }
  if (delta < beach.cove) {
    return beach.height * (1.0 - max(delta, 0.0) / beach.cove);
  }
  return fall(max(floor, -beach.coveDepth), (delta - beach.cove) / max(width, 1e-3));
}
