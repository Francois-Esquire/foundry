// The sea's bathymetry, chart units below sea level: one platform under the
// archipelago, each island's stack of bank plates on it between its top
// and bottom silhouettes, the deep's rings past its edge, and a beach or a
// drop-off at every coast. Pure: maps/height.wgsl owns the bindings and
// the loops, and calls these for its sea texels.
import { planarFbm, planarHash, planarRidged } from "../../../../shaders/noise/planar.wgsl";
import { smoothMin } from "../../../../shaders/terrain/shaping.wgsl";
import { ease } from "../maps/frame.wgsl";

export struct Bathymetry {
  // The deep floor's depth: the platform's plus the deep.
  floorDepth: f32,
  // The continental slope's width, past the escarpment.
  slopeWidth: f32,
  // The height map's texel, chart units.
  texel: f32,
}

// The platform, chart units (depths positive, below sea level).
export struct Platform {
  // Its depth: the top plus the whole stack of levels.
  base: f32,
  // How far it runs past the islands' stacks, before its edge.
  margin: f32,
  // The scale of the log-sum-exp that merges the coasts into its outline.
  merge: f32,
  // How ragged its edge is, 0 for none.
  ragged: f32,
  // The escarpment's share of the fall to the floor.
  scarp: f32,
  // The rings the slope descends in, 0 for a smooth slope.
  deepRings: u32,
}

// The beaches, chart units.
export struct Beach {
  // The farthest sand runs, and its height above the water at the crest.
  width: f32,
  height: f32,
  // Shelf depths: all sand up to the first, all drop-off past the second.
  sandDepth: f32,
  cliffDepth: f32,
  // How far a drop-off falls.
  cliff: f32,
  // Extra sand on a small island, as a share, fading out by `smallSize`.
  smallSand: f32,
  smallSize: f32,
  // How far dry sand runs into a bay the top silhouette closes over before
  // it dips under the water; 0 fills bays with sand. The bay's water is
  // at most `coveDepth` deep, shallow enough for the swell to break in.
  cove: f32,
  coveDepth: f32,
}

// The banks, chart units (depths positive).
export struct Banks {
  // The highest level's depth.
  top: f32,
  // The bottom level's rise above the platform, and each rise's share of
  // the one below, at most 1.
  step: f32,
  taper: f32,
  // The narrowest tread a ring may have, 0 for no banks.
  run: f32,
  // How far the stacks spread past the top silhouettes, before the
  // platform's outline ruffles it.
  spread: f32,
  // The top silhouette's smoothing radius, as a share of the island's size.
  hull: f32,
  // How far a bottom silhouette may run past its top, in platform reaches,
  // and the share of the platform's lobes the top one takes.
  bottomReach: f32,
  topReach: f32,
  // A riser's width as a share of its run, and the narrowest it may be.
  slope: f32,
  minRiser: f32,
  // How far a ring's edge strays, as a share of its run.
  wander: f32,
  // The share a step's rise grows by on a broad tread, 0–1, and the tread
  // that takes all of it.
  lift: f32,
  liftTread: f32,
  // The undulation every level but the top rides: its height as a share of
  // the level's own step (under half, so no level meets its neighbour), its
  // crests' way (a unit vector) and spacing, the share of a wave each level
  // is shifted from the one below, and the terraces it climbs in (0 smooth).
  undulation: f32,
  undulationLength: f32,
  undulationWay: vec2f,
  undulationShift: f32,
  undulationSteps: f32,
  // How far its crests meander, in wavelengths.
  undulationBend: f32,
  // How close two members' rings come to join as one plate.
  bridge: f32,
  // The moat a non-member cuts, as a share of its size, and how much of a
  // plate it cuts, 0–1.
  moat: f32,
  moatAmount: f32,
  // The levels, the islands the banks follow, and the banks.
  levels: u32,
  islandCount: u32,
  bankCount: u32,
}


// --- Distances ----------------------------------------------------------------

// The exact distance has creases along the medial axis (between islands,
// out of every bay) and a fan at every coast vertex; rings and beaches
// shaped by it show them as spokes. They follow a distance smoothed over
// this share of the larger of a typical stack's reach (SMOOTHING_SPREAD of
// the spread) and the beach instead.
const SMOOTHING = 0.125;
const SMOOTHING_SPREAD = 0.6;

// Whether there are banks to stand on the platform.
export fn hasBanks(banks: Banks) -> bool {
  return banks.run > 0.0 && banks.bankCount > 0u;
}

// Chart units over which the nearest coast's distance is smoothed: by the
// beach alone with no banks.
export fn smoothingScale(beach: Beach, banks: Banks) -> f32 {
  let reach = select(0.0, SMOOTHING_SPREAD * banks.spread, hasBanks(banks));
  return max(reach, beach.width) * SMOOTHING;
}

// The smoothed distance's blend: exact on the coast, so the sea meets the
// land at sea level, and the smoothed distance from a little offshore on.
// Close in, `local` (a mean over half the scale) takes over from the exact
// `d`; farther out, `smoothed` (over the whole scale).
export fn nearDistance(d: f32, local: f32, smoothed: f32, scale: f32) -> f32 {
  let near = mix(d, local, ease(0.0, 0.5 * scale, d));
  return mix(near, smoothed, ease(0.0, 2.0 * scale, d));
}

// How far p is from one island's coast. `smoothed` is the smoothed
// distance to the nearest coast (full resolution, exact at it); `own` the
// island's own distance (the coasts map's layer), and `others` the least
// of every other island's. Where the island is the nearest by a margin,
// this is `smoothed`, so its rings hug its coast; where another is, its
// own; across the medial line one eases into the other, so the field has
// no crease where the nearest island changes.
export fn islandDistance(smoothed: f32, own: f32, others: f32, blend: f32) -> f32 {
  return mix(smoothed, own, ease(-blend, blend, own - others));
}

// --- The platform -------------------------------------------------------------

// A term of the coasts' union, against the least of them: the union is
// `least - merge * log(sum of terms)`, a log-sum-exp, which unlike a
// pairwise smooth-min does not depend on the order the islands come in.
export fn mergeTerm(platform: Platform, delta: f32, least: f32) -> f32 {
  return exp(-(delta - least) / max(platform.merge, 1e-3));
}

export fn mergedDistance(platform: Platform, least: f32, terms: f32) -> f32 {
  return least - max(platform.merge, 1e-3) * log(max(terms, 1e-30));
}

// The outline's noise: broad lobes about this many reaches across, and
// notches about this many, with their salts.
const LOBE_CELL = 1.6;
const NOTCH_CELL = 0.5;
const LOBE_SALT = 720u;
const NOTCH_SALT = 723u;
// The notches' share of the raggedness, and the least of the reach a notch
// leaves.
const NOTCH_SHARE = 0.4;
const LEAST_OUTLINE = 0.2;

fn spreadOf(banks: Banks) -> f32 {
  return select(0.0, banks.spread, hasBanks(banks));
}

fn outlineCell(platform: Platform, banks: Banks) -> f32 {
  return max(spreadOf(banks) + platform.margin, 1.0);
}

// How far the platform's lobes push its outline out at p, chart units: as
// much in as out, on the whole.
export fn platformLobes(platform: Platform, banks: Banks, p: vec2f) -> f32 {
  if (platform.ragged <= 0.0) {
    return 0.0;
  }
  let lobes = planarFbm(p / (outlineCell(platform, banks) * LOBE_CELL), 3, 0.5, 1u, LOBE_SALT);
  return spreadOf(banks) * platform.ragged * lobes;
}

// How far past the merged coasts the platform's outline lies at p: the
// spread, in lobes and notches.
export fn platformReach(platform: Platform, banks: Banks, p: vec2f) -> f32 {
  let reach = spreadOf(banks);
  if (platform.ragged <= 0.0 || reach <= 0.0) {
    return reach;
  }
  let notches = planarRidged(p / (outlineCell(platform, banks) * NOTCH_CELL), 3, 0.5, 1u, NOTCH_SALT);
  let outline = reach + platformLobes(platform, banks, p) - reach * platform.ragged * NOTCH_SHARE * notches;
  return max(outline, reach * LEAST_OUTLINE);
}

// --- The silhouettes ----------------------------------------------------------

// An island's top silhouette: its coast joined smoothly with its hull, so
// headlands stay and bays close over.
export fn topSilhouette(delta: f32, hull: f32, radius: f32) -> f32 {
  return smoothMin(delta, hull, 0.5 * radius);
}

// An island's bottom silhouette: the platform's outline, within
// `bottomReach` platform reaches of its top, and room for every ring.
export fn bottomSilhouette(banks: Banks, top: f32, outline: f32, platformReach: f32, reach: f32, rings: u32) -> f32 {
  let bottom = max(outline, top - banks.bottomReach * platformReach * reach);
  return min(bottom, top - f32(rings) * banks.run);
}

// An island's tread: the way from its top silhouette to its bottom, per ring.
export fn treadOf(top: f32, bottom: f32, rings: u32) -> f32 {
  return (top - bottom) / f32(max(rings, 1u));
}

// How far p is outside the island's ring `fromTop` (1 its top ring).
export fn ringPast(top: f32, tread: f32, fromTop: u32) -> f32 {
  return top - f32(fromTop) * tread;
}

// The escarpment's width, as a share of the slope's.
const SCARP_WIDTH = 0.08;

// A riser's width for a ring of `run`: its share of it, never narrower
// than a few texels. The banks' rings and the deep's alike.
export fn riserWidth(banks: Banks, run: f32) -> f32 {
  return max(banks.slope * run, banks.minRiser);
}

// The share of the free room between two risers wander may take.
const WANDER_ROOM = 0.95;

// The deep rings. Their runs grow outward from the platform by 1 / taper a
// ring, the same rhythm the levels flatten upward by (at taper 1, even), so
// the descent crowds toward the platform as a contour map's does; each run
// strays by up to DEEP_JITTER of itself on a per-ring hash, so the spacing
// is uneven, and every run stays positive, so the rings keep their order.
// Each edge wanders on its own field, cells DEEP_WANDER_CELL runs across.
const MAX_DEEP_RINGS = 32u;
const DEEP_JITTER = 0.2;
const DEEP_SPACING_SALT = 729u;
const DEEP_WANDER_SALT = 730u;
const DEEP_WANDER_CELL = 3.0;

// Deep ring `ring`'s run before its riser, as a weight against the others':
// `rings` rings make rings + 1 runs, the first from the escarpment's foot.
fn deepWeight(banks: Banks, ring: u32, rings: u32) -> f32 {
  let crowd = pow(max(banks.taper, 1e-3), f32(rings - ring));
  let jitter = 2.0 * planarHash(vec2i(i32(ring), 0), 1u, DEEP_SPACING_SALT) - 1.0;
  return crowd * (1.0 + DEEP_JITTER * jitter);
}

// How many of the deep's rings + 1 risers p, `u` out along the slope's
// `length` from the escarpment's foot, has come down, 0 to rings + 1, each
// eased over its riser and wandered by its own field.
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

// How far past the platform's edge its fall ends, on the deep floor: the
// escarpment's width and the slope's (as `platformHeight` lays them).
export fn slopeEnd(bed: Bathymetry) -> f32 {
  let scarpWidth = max(SCARP_WIDTH * bed.slopeWidth, 3.0 * bed.texel);
  return bed.slopeWidth + 0.5 * scarpWidth;
}

// The open sea's floor grows in over this share of the slope's width past
// its end, out of the deep floor the slope comes down to.
const OPEN_RISE = 0.6;

// How far the open sea's floor (sea/seascape.wgsl) has taken over `past`
// the platform's edge, 0–1: 0 on the platform and its fall, all of it a
// little past the slope's end. The height and seabed maps sink the floor
// by it, and the water keeps the floor's relief through the deep by it.
export fn openShareOf(bed: Bathymetry, past: f32) -> f32 {
  let end = slopeEnd(bed);
  return ease(end, openWhole(bed), past);
}

// How far past the platform's edge the open sea's floor has all of it.
export fn openWhole(bed: Bathymetry) -> f32 {
  return slopeEnd(bed) + OPEN_RISE * bed.slopeWidth;
}

// Floor within this share of the deep floor's depth of it has come down to
// it: far under the height map's precision, so floor standing over the
// deep floor is never taken for it.
const ON_DEEP = 1e-4;

// How far floor `h` has come down to the deep floor, 0–1: 0 wherever it
// stands over it by more than the height map's precision. The open sea's
// floor sinks only this.
export fn deepShareOf(bed: Bathymetry, h: f32) -> f32 {
  let deep = bed.floorDepth;
  return 1.0 - ease(0.0, ON_DEEP * deep, h + deep);
}

// The platform's floor at p, `past` its edge (negative inside): flat at its
// depth, then the escarpment drops its share of the fall to the deep over
// a short run, and the slope the rest over its width: smoothly with no deep
// rings, else in rings + 1 equal drops from the escarpment's end.
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

// --- The banks ----------------------------------------------------------------

// How far level `level` (0 the deepest) stands above the platform: the
// bottom one a step, each above the taper times the rise below it
// (sea-params.ts `levelRise`, the same sum).
export fn levelRise(banks: Banks, level: u32) -> f32 {
  let count = f32(level + 1u);
  if (banks.taper >= 1.0) {
    return banks.step * count;
  }
  return banks.step * (1.0 - pow(banks.taper, count)) / (1.0 - banks.taper);
}

// How much the steps rise more where the treads are `tread` wide: all of
// the lift on broad benches, next to none where the rings crowd.
export fn liftOf(banks: Banks, tread: f32) -> f32 {
  return banks.lift * ease(0.0, banks.liftTread, tread);
}

// Level `level`'s height: its rise over the platform, so the highest, with
// the platform's depth the whole stack under the top, is at the top. `lift`
// grows the rise by that share near the platform and less toward the top,
// which stays put; every level at p takes the same lift, so they keep their
// order.
export fn levelHeight(platform: Platform, banks: Banks, level: u32, lift: f32) -> f32 {
  let rise = levelRise(banks, level);
  let whole = max(levelRise(banks, max(banks.levels, 1u) - 1u), 1e-3);
  return -platform.base + rise * (1.0 + lift * (1.0 - rise / whole));
}

// Each terrace of the undulation turns over this share of itself.
const TERRACE_TURN = 0.6;
const TAU = 6.2831853;
// The crests meander like a current over cells this many wavelengths
// across, `undulationBend` wavelengths either way; and the undulation
// swells and fades over patches this many wavelengths across, down to
// UNDULATION_CALM of itself.
const BEND_CELL = 2.5;
const PATCH_CELL = 3.0;
const UNDULATION_CALM = 0.15;
const BEND_SALT = 733u;
const PATCH_SALT = 735u;

// The undulation's wave at p, -1 to 1, for the level `place` up the stack
// (-1 the platform): a wave running along the banks' way, its crests
// meandering, shifted from level to level and climbing in terraces,
// stronger in some patches than others.
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

// Level `level`'s undulation at p, chart units up, a share of its own
// step. The same for every bank of a level; the top level has none.
export fn undulationAt(banks: Banks, p: vec2f, level: u32) -> f32 {
  if (!undulates(banks) || level + 1u >= banks.levels) {
    return 0.0;
  }
  let own = levelRise(banks, level) - select(0.0, levelRise(banks, level - 1u), level > 0u);
  return banks.undulation * own * undulationWave(banks, p, f32(level));
}

// The platform's undulation at p, chart units up: a level below the
// bottom one, a share of the bottom step, so it never meets that level.
export fn platformUndulation(banks: Banks, p: vec2f) -> f32 {
  if (!undulates(banks)) {
    return 0.0;
  }
  return banks.undulation * levelRise(banks, 0u) * undulationWave(banks, p, -1.0);
}

// The noise each bank's edge wanders by: cells this share of the spread
// across, the same for every ring.
const WANDER_CELL = 0.3;
const WANDER_SALT = 726u;
// How much an outer ring wanders against the top one.
const OUTER_WANDER = 0.4;

// How far a ring at `level` may stray: its share of its tread, less for
// the deeper levels, and never more than keeps its riser off its
// neighbours' (each a tread apart, each riser `riser` wide).
export fn wanderReach(banks: Banks, tread: f32, riser: f32, level: u32) -> f32 {
  let room = max(0.5 * (tread - riser), 0.0) * WANDER_ROOM;
  let place = f32(level + 1u) / f32(max(banks.levels, 1u));
  return min(banks.wander * tread, room) * mix(OUTER_WANDER, 1.0, place);
}

// Bank `bank`'s wander at p, -1 to 1: its own field, offset per bank so no
// two edges stray together.
export fn wanderAt(banks: Banks, p: vec2f, bank: u32) -> f32 {
  let offset = vec2f(f32(bank) * 7.31, f32(bank) * 4.46);
  let cell = max(banks.spread * WANDER_CELL, 1.0);
  let noise = planarFbm(p / cell + offset, 3, 0.5, 1u, WANDER_SALT);
  return clamp(noise, -1.0, 1.0);
}

// How much of a plate stands at p, 0–1, `outside` its edge (negative
// within): a riser `riser` wide, centred on the edge.
export fn plateCover(outside: f32, riser: f32) -> f32 {
  return 1.0 - ease(-0.5 * riser, 0.5 * riser, outside);
}

// How much of a plate an island that is not its member leaves at p, `delta`
// from its coast: the plate cut by the moat amount out to the moat (a share
// of the island's size), all of it past, eased over the plate's riser.
export fn moatKeep(banks: Banks, size: f32, delta: f32, riser: f32) -> f32 {
  let cut = banks.moat * size;
  let keep = ease(cut - 0.5 * riser, cut + 0.5 * riser, delta);
  return mix(1.0, keep, banks.moatAmount);
}

// A plate laid over the platform, `cover` of it there: its level where it
// covers, the platform where not, its riser between. The floor is the
// highest of these over every plate.
export fn plateOver(platformFloor: f32, height: f32, cover: f32) -> f32 {
  return mix(platformFloor, height, cover);
}

// How steep a coast is over a shelf `depth` down: 0 sand, 1 a drop-off.
export fn shoreSteepness(beach: Beach, depth: f32) -> f32 {
  return ease(beach.sandDepth, beach.cliffDepth, depth);
}

// How far an island's beach runs: its sand's slope, longer on a small
// island, or a drop-off over the cliff.
export fn beachWidth(beach: Beach, size: f32, steep: f32) -> f32 {
  let sand = beach.width * (1.0 + beach.smallSand * (1.0 - ease(0.0, beach.smallSize, size)));
  return mix(sand, beach.cliff, steep);
}

// A fall from sea level to `floor`, `t` of the way out: steepest at the
// water's edge, easing onto the floor.
fn fall(floor: f32, t: f32) -> f32 {
  let rest = 1.0 - saturate(t);
  return floor * (1.0 - rest * rest);
}

// One island's shore at p: sand sloping from the crest on its coast to the
// water at its top silhouette, `top` from p, then down to the floor over
// `width`; or a drop-off from its coast, `delta` from p, over the cliff.
export fn shoreHeight(beach: Beach, floor: f32, top: f32, delta: f32, width: f32, steep: f32) -> f32 {
  var sand = fall(floor, top / max(width, 1e-3));
  if (top <= 0.0) {
    sand = beach.height * -top / max(max(delta, 0.0) - top, 1e-3);
  }
  sand = min(sand, coveHeight(beach, floor, delta, width));
  return mix(sand, fall(floor, delta / max(beach.cliff, 1e-3)), steep);
}

// A bay's floor `delta` from its coast: a strip of dry sand `cove` wide,
// then the fall a beach makes to a shallow lagoon, so a wide bay holds
// water. A straight beach falls below it, and keeps its own.
fn coveHeight(beach: Beach, floor: f32, delta: f32, width: f32) -> f32 {
  if (beach.cove <= 0.0) {
    return beach.height;
  }
  if (delta < beach.cove) {
    return beach.height * (1.0 - max(delta, 0.0) / beach.cove);
  }
  return fall(max(floor, -beach.coveDepth), (delta - beach.cove) / max(width, 1e-3));
}
