import {
  Banks,
  Bathymetry,
  Beach,
  beachWidth,
  bottomSilhouette,
  deepShareOf,
  hasBanks,
  islandDistance,
  levelHeight,
  liftOf,
  mergedDistance,
  mergeTerm,
  moatKeep,
  nearDistance,
  openShareOf,
  Platform,
  platformHeight,
  platformLobes,
  platformReach,
  plateCover,
  plateOver,
  ringPast,
  riserWidth,
  shoreHeight,
  shoreSteepness,
  smoothingScale,
  topSilhouette,
  platformUndulation,
  treadOf,
  undulationAt,
  wanderAt,
  wanderReach,
} from "../sea/bathymetry.wgsl";
import { smoothMin } from "../../../../shaders/terrain/shaping.wgsl";
import { Land, landHeight } from "../land/land.wgsl";
import { openCoast, Seascape, seascapeSink, sunkGround } from "../sea/seascape.wgsl";
import { ease, MapFrame, texelCenter } from "./frame.wgsl";

struct HeightParams {
  frame: MapFrame,
  land: Land,
  rimSmoothing: f32,
  bed: Bathymetry,
  platform: Platform,
  banks: Banks,
  beach: Beach,
  coastColumns: u32,
  rowStart: u32,
  seascape: Seascape,
}

const LAND_PAST = -1024.0;
const FAR_PAST = 16384.0;

struct BankIsland {
  rings: u32,
  size: f32,
  reach: f32,
}

struct Bank {
  memberStart: u32,
  memberCount: u32,
  level: u32,
  id: u32,
  mask: vec2u,
}

@group(0) @binding(0) var<uniform> params: HeightParams;
@group(0) @binding(1) var distance: texture_2d<f32>;
@group(0) @binding(2) var linear: sampler;
@group(0) @binding(3) var coasts: texture_2d_array<f32>;
@group(0) @binding(4) var<storage, read> bankIslands: array<BankIsland>;
@group(0) @binding(5) var<storage, read> banks: array<Bank>;
@group(0) @binding(6) var<storage, read> members: array<vec2u>;

override SCALABLE_HEIGHT: bool = false;
override WRITE_FOOTPRINTS: bool = false;

struct IslandState {
  own: f32,
  delta: f32,
  top: f32,
  tread: f32,
}

@group(0) @binding(7) var<storage, read_write> states: array<IslandState>;
@group(0) @binding(8) var<storage, read_write> masks: array<vec4u>;
@group(0) @binding(9) var footprint: texture_storage_2d_array<rgba32uint, write>;

var<private> stateBase: u32;
var<private> maskBase: u32;
var<private> own: array<f32, 64>;
var<private> delta: array<f32, 64>;
var<private> top: array<f32, 64>;
var<private> tread: array<f32, 64>;

fn get_own(i: u32) -> f32 {
  if (SCALABLE_HEIGHT) {
    return states[stateBase + i].own;
  }
  return own[i];
}

fn set_own(i: u32, value: f32) {
  if (SCALABLE_HEIGHT) {
    states[stateBase + i].own = value;
  } else {
    own[i] = value;
  }
}

fn get_delta(i: u32) -> f32 {
  if (SCALABLE_HEIGHT) {
    return states[stateBase + i].delta;
  }
  return delta[i];
}

fn set_delta(i: u32, value: f32) {
  if (SCALABLE_HEIGHT) {
    states[stateBase + i].delta = value;
  } else {
    delta[i] = value;
  }
}

fn get_top(i: u32) -> f32 {
  if (SCALABLE_HEIGHT) {
    return states[stateBase + i].top;
  }
  return top[i];
}

fn set_top(i: u32, value: f32) {
  if (SCALABLE_HEIGHT) {
    states[stateBase + i].top = value;
  } else {
    top[i] = value;
  }
}

fn get_tread(i: u32) -> f32 {
  if (SCALABLE_HEIGHT) {
    return states[stateBase + i].tread;
  }
  return tread[i];
}

fn set_tread(i: u32, value: f32) {
  if (SCALABLE_HEIGHT) {
    states[stateBase + i].tread = value;
  } else {
    tread[i] = value;
  }
}

fn coastAt(uv: vec2f, island: u32) -> f32 {
  let columns = params.coastColumns;
  if (columns == 1u) {
    return textureSampleLevel(coasts, linear, uv, i32(island), 0.0).r;
  }
  let cells = columns * columns;
  let cell = island % cells;
  let side = f32(textureDimensions(coasts).x / columns);
  let local = clamp(uv, vec2f(0.5 / side), vec2f(1.0 - 0.5 / side));
  let at = (vec2f(f32(cell % columns), f32(cell / columns)) + local) / f32(columns);
  return textureSampleLevel(coasts, linear, at, i32(island / cells), 0.0).r;
}

// Match maps/bake-layout.ts and view/selection-resolve.wgsl.
const BANKS_PER_PAGE = 128u;

fn footprintPages() -> u32 {
  return max(1u, (params.banks.bankCount + BANKS_PER_PAGE - 1u) / BANKS_PER_PAGE);
}

fn writeMasks(at: vec2u, land: bool) {
  if (!WRITE_FOOTPRINTS) {
    return;
  }
  for (var page = 0u; page < footprintPages(); page++) {
    textureStore(footprint, at, i32(page), select(masks[maskBase + page], vec4u(0u), land));
  }
}
const FAR = 3.0e38;

const RING_TAPS = 8u;
const TAU = 6.2831853;

fn distanceNear(p: vec2f) -> f32 {
  let side = params.frame.texel * f32(params.frame.resolution);
  return textureSampleLevel(distance, linear, (p - params.frame.origin) / side, 0.0).r;
}

fn easedDistance(p: vec2f, d: f32, radius: f32) -> f32 {
  var sum = d;
  var weight = 1.0;
  for (var i = 0u; i < RING_TAPS; i++) {
    let inner = (f32(i) + 0.5) * TAU / f32(RING_TAPS);
    let outer = f32(i) * TAU / f32(RING_TAPS);
    sum += distanceNear(p + vec2f(cos(inner), sin(inner)) * 0.5 * radius) * 0.75;
    sum += distanceNear(p + vec2f(cos(outer), sin(outer)) * radius) * 0.4;
    weight += 0.75 + 0.4;
  }
  return sum / weight;
}

fn distanceSpline(uv: vec2f, level: u32) -> f32 {
  let size = vec2f(textureDimensions(distance, level));
  let st = uv * size - 0.5;
  let i = floor(st);
  let f = st - i;
  let f2 = f * f;
  let f3 = f2 * f;
  let w0 = (1.0 - 3.0 * f + 3.0 * f2 - f3) / 6.0;
  let w1 = (4.0 - 6.0 * f2 + 3.0 * f3) / 6.0;
  let w2 = (1.0 + 3.0 * f + 3.0 * f2 - 3.0 * f3) / 6.0;
  let w3 = f3 / 6.0;
  let g0 = w0 + w1;
  let g1 = w2 + w3;
  let h0 = (i - 0.5 + w1 / g0) / size;
  let h1 = (i + 1.5 + w3 / g1) / size;
  let lod = f32(level);
  return g0.y * (g0.x * textureSampleLevel(distance, linear, vec2f(h0.x, h0.y), lod).r
      + g1.x * textureSampleLevel(distance, linear, vec2f(h1.x, h0.y), lod).r)
    + g1.y * (g0.x * textureSampleLevel(distance, linear, vec2f(h0.x, h1.y), lod).r
      + g1.x * textureSampleLevel(distance, linear, vec2f(h1.x, h1.y), lod).r);
}

fn smoothedDistance(p: vec2f, scale: f32) -> f32 {
  let side = params.frame.texel * f32(params.frame.resolution);
  let uv = (p - params.frame.origin) / side;
  let top = f32(textureNumLevels(distance) - 1u);
  let lod = clamp(log2(max(scale / params.frame.texel, 1.0)), 0.0, top);
  let below = u32(floor(lod));
  let above = min(below + 1u, u32(top));
  return mix(distanceSpline(uv, below), distanceSpline(uv, above), fract(lod));
}

fn blendedDistance(p: vec2f, d: f32, scale: f32) -> f32 {
  if (scale <= params.frame.texel) {
    return d;
  }
  return nearDistance(d, easedDistance(p, d, 0.5 * scale), smoothedDistance(p, scale), scale);
}

const HULL_TAPS = 16u;
const GOLDEN_ANGLE = 2.3999632;

fn hullDistance(uv: vec2f, island: u32, side: f32, radius: f32) -> f32 {
  var sum = 0.0;
  for (var k = 0u; k < HULL_TAPS; k++) {
    let r = radius * sqrt((f32(k) + 0.5) / f32(HULL_TAPS));
    let a = f32(k) * GOLDEN_ANGLE;
    let at = uv + vec2f(cos(a), sin(a)) * r / side;
    sum += coastAt(at, island);
  }
  return sum / f32(HULL_TAPS);
}

fn isMember(bank: Bank, island: u32) -> bool {
  if (SCALABLE_HEIGHT) {
    let end = bank.memberStart + bank.memberCount;
    var lo = bank.memberStart;
    var hi = end;
    while (lo < hi) {
      let mid = lo + (hi - lo) / 2u;
      if (members[mid].x < island) {
        lo = mid + 1u;
      } else {
        hi = mid;
      }
    }
    return lo < end && members[lo].x == island;
  }
  return ((bank.mask[island / 32u] >> (island % 32u)) & 1u) == 1u;
}

struct SeaFloor {
  height: f32,
  ring: u32,
  under: vec3u,
  past: f32,
}

// Match maps/bake-layout.ts and scene/water.wgsl.
const RING_BITS = 48u;

fn seaFloor(p: vec2f, d: f32) -> SeaFloor {
  let bed = params.bed;
  let platform = params.platform;
  let b = params.banks;
  let count = b.islandCount;
  if (WRITE_FOOTPRINTS) {
    for (var page = 0u; page < footprintPages(); page++) {
      masks[maskBase + page] = vec4u(0u);
    }
  }
  let side = params.frame.texel * f32(params.frame.resolution);
  let uv = (p - params.frame.origin) / side;
  let scale = smoothingScale(params.beach, b);
  let smoothed = blendedDistance(p, d, scale);

  var least = FAR;
  var second = FAR;
  for (var i = 0u; i < count; i++) {
    set_own(i, coastAt(uv, i));
    second = min(second, max(least, get_own(i)));
    least = min(least, get_own(i));
  }

  let coastsTexel = side / f32(textureDimensions(coasts).x / params.coastColumns);
  let blend = 2.0 * max(scale, coastsTexel);
  for (var i = 0u; i < count; i++) {
    let others = select(least, second, get_own(i) <= least);
    set_delta(i, islandDistance(smoothed, get_own(i), others, blend));
  }

  let banked = hasBanks(b);
  var terms = 0.0;
  for (var i = 0u; i < count; i++) {
    terms += mergeTerm(platform, get_delta(i), least);
  }
  let merged = min(mergedDistance(platform, least, terms), smoothed);
  let reach = platformReach(platform, b, p);
  let lobes = platformLobes(platform, b, p);
  let outline = merged - reach;

  var stacks = FAR;
  var weights = 0.0;
  var treads = 0.0;
  for (var i = 0u; i < count; i++) {
    let island = bankIslands[i];
    let rings = select(0u, island.rings, banked);
    set_top(i, get_delta(i));
    set_tread(i, b.run);
    if (rings == 0u) {
      continue;
    }
    let radius = b.hull * island.size;
    let farthest = max(b.bottomReach * reach * island.reach, f32(rings) * b.run) + radius;
    if (radius > coastsTexel && get_own(i) < farthest) {
      set_top(i, topSilhouette(get_delta(i), hullDistance(uv, i, side, radius), radius));
    }
    let bottom = bottomSilhouette(b, get_top(i), outline, reach, island.reach, rings);
    set_top(i, get_top(i) - (b.topReach * lobes * island.reach));
    set_tread(i, treadOf(get_top(i), bottom, rings));
    stacks = min(stacks, bottom);
    let weight = mergeTerm(platform, get_delta(i), least);
    weights += weight;
    treads += weight * get_tread(i);
  }
  let lift = liftOf(b, select(0.0, treads / weights, weights > 0.0));

  let past = smoothMin(outline, stacks, platform.margin) - platform.margin;
  let base = platformHeight(bed, platform, b, p, past);
  let onTop = 1.0 - ease(0.0, b.step, -platform.base - base);
  var ground = base + platformUndulation(b, p) * onTop;
  let share = openShareOf(bed, past) * deepShareOf(bed, ground);
  if (share > 0.0) {
    let coast = openCoast(distance, params.frame, params.seascape, p);
    let sink = share * seascapeSink(params.seascape, p, coast.distance, coast.fall);
    ground = sunkGround(params.seascape, ground, sink, bed.floorDepth);
  }

  var floor = ground;
  var shelf = -platform.base;
  var ring = 0u;
  var under = vec3u(0u);
  for (var g = 0u; g < select(0u, b.bankCount, banked); g++) {
    let bank = banks[g];
    var outside = FAR;
    var run = b.run;
    for (var m = 0u; m < bank.memberCount; m++) {
      let member = members[bank.memberStart + m];
      if (member.x >= count) {
        continue;
      }
      let past = ringPast(get_top(member.x), get_tread(member.x), member.y);
      run = mix(run, get_tread(member.x), clamp(0.5 + 0.25 * (outside - past) / max(b.bridge, 1e-3), 0.0, 1.0));
      outside = smoothMin(outside, past, 2.0 * b.bridge);
    }
    if (outside >= FAR) {
      continue;
    }
    let riser = riserWidth(b, run);
    let stray = wanderReach(b, run, riser, bank.level);
    if (outside - stray >= 0.5 * riser) {
      continue;
    }
    var edgeAt = outside;
    if (stray > 0.0 && outside + stray > -0.5 * riser) {
      edgeAt += stray * wanderAt(b, p, g);
    }
    var cover = plateCover(edgeAt, riser);
    for (var i = 0u; i < count; i++) {
      if (cover > 0.0 && !isMember(bank, i)) {
        cover *= moatKeep(b, bankIslands[i].size, get_delta(i), riser);
      }
    }
    if (WRITE_FOOTPRINTS && cover > 0.5) {
      let page = bank.id / BANKS_PER_PAGE;
      let bit = bank.id % BANKS_PER_PAGE;
      masks[maskBase + page][bit / 32u] |= 1u << (bit % 32u);
    }
    if (cover > 0.5 && bank.id < RING_BITS) {
      under[bank.id / 16u] |= 1u << (bank.id % 16u);
    }
    if (cover > 0.0) {
      let level = levelHeight(platform, b, bank.level, lift);
      let plate = plateOver(ground, level + undulationAt(b, p, bank.level), cover);
      if (plate > floor) {
        floor = plate;
        ring = bank.id + 1u;
      }
      shelf = max(shelf, plateOver(-platform.base, level, cover));
    }
  }

  let beach = params.beach;
  let steep = shoreSteepness(beach, -shelf);
  var shore = select(floor, shoreHeight(beach, floor, d, d, beach.width, steep), count == 0u);
  for (var i = 0u; i < count; i++) {
    let width = beachWidth(beach, bankIslands[i].size, steep);
    shore = max(shore, shoreHeight(beach, floor, get_top(i), get_delta(i), width, steep));
  }
  return SeaFloor(shore, ring, under, past);
}

fn coastHeight(p: vec2f, inland: f32) -> f32 {
  if (inland >= params.land.rimWidth) {
    return 0.0;
  }
  let texel = params.frame.texel;
  let grad = vec2f(
    distanceNear(p + vec2f(texel, 0.0)) - distanceNear(p - vec2f(texel, 0.0)),
    distanceNear(p + vec2f(0.0, texel)) - distanceNear(p - vec2f(0.0, texel)),
  );
  let coast = p + grad / max(length(grad), 1e-6) * inland;
  return seaFloor(coast, 0.0).height;
}

struct Texel {
  @location(0) height: vec4f,
  @location(1) ring: vec4u,
}

@fragment
fn fs_main(@builtin(position) position: vec4f) -> Texel {
  let texel = vec2u(floor(position.xy));
  let pixel = (texel.y - params.rowStart) * params.frame.resolution + texel.x;
  stateBase = pixel * params.banks.islandCount;
  maskBase = pixel * footprintPages();
  let d = textureLoad(distance, texel, 0).r;
  let p = texelCenter(params.frame, texel);
  if (d >= 0.0) {
    let sea = seaFloor(p, d);
    writeMasks(texel, false);
    let past = clamp(sea.past, LAND_PAST, FAR_PAST);
    return Texel(vec4f(sea.height, -d, sea.height, past), vec4u(sea.ring, sea.under));
  }
  let inland = -d;
  var shaped = inland;
  if (params.rimSmoothing > 0.0) {
    let eased = -easedDistance(p, d, params.rimSmoothing);
    shaped = mix(inland, eased, ease(0.0, params.rimSmoothing, inland));
  }
  let coast = coastHeight(p, inland);
  writeMasks(texel, true);
  return Texel(vec4f(landHeight(params.land, shaped, coast), shaped, coast, LAND_PAST), vec4u(0u));
}

struct FullscreenVertexOut {
  @builtin(position) position: vec4f,
  @location(0) uv: vec2f,
}

@vertex
fn vs_main(@builtin(vertex_index) vi: u32) -> FullscreenVertexOut {
  var pos = array<vec2f, 3>(vec2f(-1.0, -1.0), vec2f(3.0, -1.0), vec2f(-1.0, 3.0));
  var uv = array<vec2f, 3>(vec2f(0.0, 1.0), vec2f(2.0, 1.0), vec2f(0.0, -1.0));
  var out: FullscreenVertexOut;
  out.position = vec4f(pos[vi], 0.0, 1.0);
  out.uv = uv[vi];
  return out;
}
