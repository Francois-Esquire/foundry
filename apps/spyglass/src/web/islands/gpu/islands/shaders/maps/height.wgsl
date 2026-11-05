// The height map: the land as a plate with a rim and a lip, the sea as the
// sea's bathymetry (sea/bathymetry.wgsl): the platform under the whole
// archipelago, each island's stack of the banks' plates on it from its top
// silhouette to its bottom, the deep's rings round it, and a beach down
// from every coast.
// Chart units, sea level 0, continuous across the coast. The land is a
// function of the distance alone; the sea of the distance, every island's
// own distance (the coasts map), and which groups the islands are in.
import {
  Banks,
  Bathymetry,
  Beach,
  beachWidth,
  bottomSilhouette,
  hasBanks,
  islandDistance,
  levelHeight,
  liftOf,
  mergedDistance,
  mergeTerm,
  moatKeep,
  nearDistance,
  Platform,
  platformHeight,
  platformLobes,
  platformReach,
  plateCover,
  plateOver,
  ringPast,
  riserWidth,
  settle,
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
import { ease, MapFrame, texelCenter } from "./frame.wgsl";

struct HeightParams {
  frame: MapFrame,
  land: Land,
  // Chart units over which the rim's distance is eased, so the rim and lip
  // follow the coast's course without its finest wiggles. 0 for none.
  rimSmoothing: f32,
  bed: Bathymetry,
  platform: Platform,
  banks: Banks,
  beach: Beach,
  coastColumns: u32,
  rowStart: u32,
}

// One island as the banks see it: its rings, its size, and its own scale on
// its stack's reach.
struct BankIsland {
  rings: u32,
  size: f32,
  reach: f32,
}

// One bank, laid out by level (the deepest first): its members (a range of
// `members`), its level, its index in the global order (banks.ts), and its
// members as a bit per island index.
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
// Layer i: island i's own signed distance (maps/coasts.wgsl).
@group(0) @binding(3) var coasts: texture_2d_array<f32>;
@group(0) @binding(4) var<storage, read> bankIslands: array<BankIsland>;
@group(0) @binding(5) var<storage, read> banks: array<Bank>;
// One record per member of a bank: the island's index, and how many of its
// rings stand from this one up (1 for its top ring), so the ring's edge is
// that many runs from its coast.
@group(0) @binding(6) var<storage, read> members: array<vec2u>;

// Pipeline specializations (bake-layout.ts `capacityOf`). Charts of up
// to 64 islands keep each texel's island state in private arrays; larger
// ones keep it in `states`, a stripe of rows at a time. Charts with banks
// past the rings map's bits also write every bank's footprint.
override SCALABLE_HEIGHT: bool = false;
override WRITE_FOOTPRINTS: bool = false;

// One island's state at the texel being baked (see `seaFloor`).
struct IslandState {
  own: f32,
  delta: f32,
  top: f32,
  tread: f32,
}

@group(0) @binding(7) var<storage, read_write> states: array<IslandState>;
@group(0) @binding(8) var<storage, read_write> masks: array<vec4u>;
@group(0) @binding(9) var footprint: texture_storage_2d_array<rgba32uint, write>;

// Where this texel's island states and footprint pages start.
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

// An island's own distance at map uv. Large charts pack the coasts map as
// an atlas, `coastColumns` cells a side per layer; a cell's uv is held half
// a texel inside it, so bilinear reads never bleed into a neighbour.
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

// Banks per footprint layer: the 128 bits of an rgba32uint texel.
const BANKS_PER_PAGE = 128u;

// The footprint's layers: at least one.
fn footprintPages() -> u32 {
  return max(1u, (params.banks.bankCount + BANKS_PER_PAGE - 1u) / BANKS_PER_PAGE);
}

// Every bank whose plate covers this texel, as `seaFloor` gathered them;
// none on land.
fn writeMasks(at: vec2u, land: bool) {
  if (!WRITE_FOOTPRINTS) {
    return;
  }
  for (var page = 0u; page < footprintPages(); page++) {
    textureStore(footprint, at, i32(page), select(masks[maskBase + page], vec4u(0u), land));
  }
}
const FAR = 3.0e38;

// A fixed disc of taps for the rim's ease: the centre, an inner ring and an
// outer ring offset by half a step, in units of the ease's radius, weighted
// toward the centre.
const RING_TAPS = 8u;
const TAU = 6.2831853;

fn distanceNear(p: vec2f) -> f32 {
  let side = params.frame.texel * f32(params.frame.resolution);
  return textureSampleLevel(distance, linear, (p - params.frame.origin) / side, 0.0).r;
}

// The mean distance over a disc of `radius` around p.
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

// The distance at uv from mip `level` (a box-filtered pyramid), through a
// cubic B-spline so the result is smooth to the second derivative: four
// bilinear taps placed to weigh sixteen texels.
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

// The distance smoothed over about `scale` chart units: the spline through
// the two mip levels either side of that scale, mixed by a weight that is
// the same everywhere, so the mix adds no seam.
fn smoothedDistance(p: vec2f, scale: f32) -> f32 {
  let side = params.frame.texel * f32(params.frame.resolution);
  let uv = (p - params.frame.origin) / side;
  let top = f32(textureNumLevels(distance) - 1u);
  let lod = clamp(log2(max(scale / params.frame.texel, 1.0)), 0.0, top);
  let below = u32(floor(lod));
  let above = min(below + 1u, u32(top));
  return mix(distanceSpline(uv, below), distanceSpline(uv, above), fract(lod));
}

// The exact distance blended into one smoothed over `scale` from a little
// offshore on (sea/bathymetry.wgsl `nearDistance`), from the distance taps
// it blends.
fn blendedDistance(p: vec2f, d: f32, scale: f32) -> f32 {
  if (scale <= params.frame.texel) {
    return d;
  }
  return nearDistance(d, easedDistance(p, d, 0.5 * scale), smoothedDistance(p, scale), scale);
}

// The hull's taps: a sunflower disc, even over its area.
const HULL_TAPS = 16u;
const GOLDEN_ANGLE = 2.3999632;

// Island `island`'s own distance at uv, averaged over a disc of `radius`.
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
  // Large charts: a binary search of the bank's members, sorted by island.
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

// The sea floor at p; the bank whose plate it stands on, its id + 1, 0 on
// the platform or the deep; and every bank whose plate covers it, under
// whatever stands on it, a bit per id (the first RING_BITS ids).
struct SeaFloor {
  height: f32,
  ring: u32,
  under: vec3u,
}

// The banks the rings map's footprint holds: 16 bits in each of g, b, a.
const RING_BITS = 48u;

// The sea floor at p, `d` from the nearest coast (exact) and `edge` from
// the frame's edge.
fn seaFloor(p: vec2f, d: f32, edge: f32) -> SeaFloor {
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

  // Every island's own distance, and the two least.
  var least = FAR;
  var second = FAR;
  for (var i = 0u; i < count; i++) {
    set_own(i, coastAt(uv, i));
    second = min(second, max(least, get_own(i)));
    least = min(least, get_own(i));
  }

  // Each island's distance for its rings and beach: the smoothed nearest
  // where it is the nearest, its own elsewhere. The coasts map's texel
  // bounds how sharply one may hand over to the other.
  let coastsTexel = side / f32(textureDimensions(coasts).x / params.coastColumns);
  let blend = 2.0 * max(scale, coastsTexel);
  for (var i = 0u; i < count; i++) {
    let others = select(least, second, get_own(i) <= least);
    set_delta(i, islandDistance(smoothed, get_own(i), others, blend));
  }

  // The platform's outline: the coasts merged, pushed out by its reach.
  let banked = hasBanks(b);
  var terms = 0.0;
  for (var i = 0u; i < count; i++) {
    terms += mergeTerm(platform, get_delta(i), least);
  }
  let merged = min(mergedDistance(platform, least, terms), smoothed);
  let reach = platformReach(platform, b, p);
  let lobes = platformLobes(platform, b, p);
  let outline = merged - reach;

  // Each banked island's silhouettes and tread.
  var stacks = FAR;
  // The treads here, each island's weighted toward the nearer coasts as
  // the platform merges them, for the lift.
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
    // The platform's lobes carry up into the top silhouette.
    set_top(i, get_top(i) - (b.topReach * lobes * island.reach));
    set_tread(i, treadOf(get_top(i), bottom, rings));
    stacks = min(stacks, bottom);
    let weight = mergeTerm(platform, get_delta(i), least);
    weights += weight;
    treads += weight * get_tread(i);
  }
  let lift = liftOf(b, select(0.0, treads / weights, weights > 0.0));

  // The platform runs its margin past its outline and every stack.
  // Its top undulates as the levels do, fading out down its fall.
  let base = platformHeight(bed, platform, b, p, smoothMin(outline, stacks, platform.margin) - platform.margin);
  let onTop = 1.0 - ease(0.0, b.step, -platform.base - base);
  let ground = base + platformUndulation(b, p) * onTop;

  // The plates, each over the platform; the highest wins. `shelf` leaves
  // out the platform's fall past its edge: what a coast here stands on.
  var floor = ground;
  var shelf = -platform.base;
  var ring = 0u;
  var under = vec3u(0u);
  for (var g = 0u; g < select(0u, b.bankCount, banked); g++) {
    let bank = banks[g];
    // How far p is outside the bank's rings joined; the nearer member's
    // tread, handed over across the bridge, sets the riser.
    var outside = FAR;
    var run = b.run;
    for (var m = 0u; m < bank.memberCount; m++) {
      let member = members[bank.memberStart + m];
      if (member.x >= count) {
        continue;
      }
      let past = ringPast(get_top(member.x), get_tread(member.x), member.y);
      run = mix(run, get_tread(member.x), clamp(0.5 + 0.25 * (outside - past) / max(b.bridge, 1e-3), 0.0, 1.0));
      // Two members' rings whose edges come within the bridge of each
      // other run across as one plate.
      outside = smoothMin(outside, past, 2.0 * b.bridge);
    }
    if (outside >= FAR) {
      continue;
    }
    let riser = riserWidth(b, run);
    let stray = wanderReach(b, run, riser, bank.level);
    // Past the farthest the edge can stray and its riser: nothing here.
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
      // The coast's tier reads the level as it stands without the undulation.
      let level = levelHeight(platform, b, bank.level, lift);
      let plate = plateOver(ground, level + undulationAt(b, p, bank.level), cover);
      if (plate > floor) {
        floor = plate;
        ring = bank.id + 1u;
      }
      shelf = max(shelf, plateOver(-platform.base, level, cover));
    }
  }

  // Every coast falls to the floor: a beach over a shallow shelf, a drop-off
  // over a deep one.
  let beach = params.beach;
  let steep = shoreSteepness(beach, -shelf);
  var shore = select(floor, shoreHeight(beach, floor, d, d, beach.width, steep), count == 0u);
  for (var i = 0u; i < count; i++) {
    let width = beachWidth(beach, bankIslands[i].size, steep);
    shore = max(shore, shoreHeight(beach, floor, get_top(i), get_delta(i), width, steep));
  }
  return SeaFloor(settle(bed, shore, edge), ring, under);
}

// How far p is from the frame's edge.
fn frameEdge(p: vec2f) -> f32 {
  let side = params.frame.texel * f32(params.frame.resolution);
  let fromOrigin = p - params.frame.origin;
  return min(min(fromOrigin.x, fromOrigin.y), min(side - fromOrigin.x, side - fromOrigin.y));
}

// The shore's height on the coast nearest land point p, `inland` of it.
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
  return seaFloor(coast, 0.0, frameEdge(coast)).height;
}

struct Texel {
  // r: the height. g, b: what the terrain rebuilds the land from, both
  // smooth across texels: the rim's distance inland (negative at sea) and
  // the floor at the coast (the floor itself at sea).
  @location(0) height: vec4f,
  // r: the bank whose plate the sea floor stands on, its id + 1; 0 on
  // land, the platform and the deep. g, b, a: every bank whose plate
  // covers it, a bit per id.
  @location(1) ring: vec4u,
}

@fragment
fn fs_main(@builtin(position) position: vec4f) -> Texel {
  let texel = vec2u(floor(position.xy));
  // This texel's place in the stripe of rows the workspace holds.
  let pixel = (texel.y - params.rowStart) * params.frame.resolution + texel.x;
  stateBase = pixel * params.banks.islandCount;
  maskBase = pixel * footprintPages();
  let d = textureLoad(distance, texel, 0).r;
  let p = texelCenter(params.frame, texel);
  if (d >= 0.0) {
    let sea = seaFloor(p, d, frameEdge(p));
    writeMasks(texel, false);
    return Texel(vec4f(sea.height, -d, sea.height, 1.0), vec4u(sea.ring, sea.under));
  }
  // The eased distance takes over from the exact one across the first
  // `rimSmoothing` inland, so the rise still begins exactly on the coast.
  let inland = -d;
  var shaped = inland;
  if (params.rimSmoothing > 0.0) {
    let eased = -easedDistance(p, d, params.rimSmoothing);
    shaped = mix(inland, eased, ease(0.0, params.rimSmoothing, inland));
  }
  let coast = coastHeight(p, inland);
  writeMasks(texel, true);
  return Texel(vec4f(landHeight(params.land, shaped, coast), shaped, coast, 1.0), vec4u(0u));
}

// The vertex an effect would supply, for drawing this as a `draw`, which
// takes the pipeline constants an effect can't: one triangle over the
// target, uv 0 at its top left.
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
