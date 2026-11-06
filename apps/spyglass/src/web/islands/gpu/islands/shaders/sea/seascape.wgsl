// The open sea's floor, past the platform's slope: it only ever goes down
// from the deep floor the slope reaches. It grows in from the calm (about
// where the slope ends) by its distance from the nearest coast, so short of
// it the floor is the deep floor exactly, and it sinks away from the
// archipelago in the archipelago's own outline, rounding off as it goes.
// The fall swings: its lines wander in and out across the formations, so
// it veers, and broad sills hold it back along winding crests, so it
// stalls, turns and rises again toward the deep floor between basins.
// Broad basins and long, winding troughs sink it further, their grain bent
// by a warp. Between them: canyons that leave the slope downhill from the
// coasts, meandering, swinging and deepening as they go; fault scarps,
// where the floor on one side of a wandering line has dropped; abyssal
// hills furrowing the basins; and sinkholes. It is cut into steps, as the
// archipelago's own floor is: whole steps of log depth from the deep floor,
// so the slope's last step down is the first of them and the gaps widen as
// the floor goes deeper, until it lies past what the water shows and the
// sea is open water. The height map lays it past the platform's slope
// (maps/height.wgsl) and the seabed map carries it on past the frame
// (maps/seabed.wgsl), both from these functions and from the same reads of
// the distance map, so they meet without a seam. Pure: the entry shaders
// own the bindings and pass the distance map in.
import { planarFbm, planarHash, planarHash2, planarNoise, planarRidged } from "../../../../shaders/noise/planar.wgsl";
import { terrace } from "../../../../shaders/terrain/shaping.wgsl";
import { ease, MapFrame } from "../maps/frame.wgsl";

export struct Seascape {
  // How far the basins, troughs, hills and sinkholes sink the floor, at
  // most, chart units. 0 for none.
  basins: f32,
  // The formations' size, chart units: about a basin's width.
  scale: f32,
  // How far the warp bends the formations and the fall swings, 0 not at
  // all, 1 freely.
  veer: f32,
  // Each step's depth against the one above it, over 1; 1 for no steps.
  step: f32,
  // How far the floor sinks per chart unit out from the coasts, past
  // `calm` (where the platform's slope ends, about); everything grows in
  // over `rise` past it.
  descent: f32,
  calm: f32,
  rise: f32,
  // About the archipelago's radius, chart units: the ways out from its
  // coasts fan apart as from a disc this size.
  radius: f32,
  // The most of the fall the sills hold back on their crests, 0–1.
  sills: f32,
  // The abyssal hills, as a share of `basins`; the canyons' and the
  // faults' depth, chart units; the share of sinkhole cells holding one.
  hills: f32,
  canyons: f32,
  faults: f32,
  pits: f32,
  seed: u32,
}

// Salts (../../../../shaders/README.md): 740–744 the warp, 746–748 the
// basins, 750–752 the troughs, 753–754 the hills, 755–756 the faults,
// 757 and 736–737 the canyons, 759 and 738–739 the sinkholes, 762–763
// the fall's swing and 764–765 the sills.
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

// The warp's cells, in formations, and how far it moves a point at full
// veer.
const WARP_CELL = 2.5;
const WARP_REACH = 0.9;
// The basins: broad, smooth, two octaves; their share of `basins`.
const BASIN = 0.55;
// The troughs wind along the zero lines of their own field, cells this many
// formations across; their share of `basins`, and how narrow they are.
const TROUGH_CELL = 1.6;
const TROUGH = 0.6;
const TROUGH_NARROW = 3.0;
// A step's riser, as a share of the step, and how much of the floor's
// slope its tread keeps.
const RISER = 0.35;
const TREAD_TILT = 0.1;

// The fall's swing: its lines move in and out by up to this many
// formations at full veer, over cells this many formations across, growing
// in over a formation past the calm.
const SWING = 0.35;
const SWING_CELL = 1.4;
// The sills: winding crests, cells this many formations across, that hold
// back up to `sills` of the fall; the crest narrows by this power.
const SILL_CELL = 1.1;
const SILL_NARROW = 2.0;

// The abyssal hills: furrows a third of a formation across, ridged so
// their crests sink least, the troughs between them broad; `hills` of
// `basins` deep at most.
const HILL_CELL = 0.3;

// The faults: wandering lines cells this many formations across, the floor
// on one side dropped, the drop's cliff this narrow (a share of the
// field's range).
const FAULT_CELL = 2.2;
const FAULT_EDGE = 0.04;
const FAULT_OFFSET = vec2f(9.4, 2.8);

// The open floor reads its distance from the coasts, and the canyons the
// way out from them, blurred over this many formations (`openCoast`). The
// canyons fade out where that way is unclear, where the ways from two
// coasts meet and it is short, from the first length to the second.
const COAST_BLUR = 0.08;
const CANYON_CLEAR = vec2f(0.85, 0.97);
// Their heads lie along the calm's line, on the zero lines of a smooth
// field with cells this many formations across. Each is this wide where it
// starts, a share of a formation, widening by this share of its run out;
// the field's slope across a zero line is about this, against its cell.
const CANYON_CELL = 0.7;
const CANYON_WIDTH = 0.1;
const CANYON_WIDEN = 0.06;
const CANYON_SLOPE = 1.5;
// Each meanders sideways by up to this many formations, over runs this
// many formations long, so now and then it swings well off the way out;
// and it deepens to its full depth over this many formations past the
// calm.
const CANYON_MEANDER = 0.35;
const CANYON_RUN = 1.1;
const CANYON_DEEPEN = 0.35;

// The sinkholes: cells this many formations across; a pit's radius, a
// share of the cell, the least and the most.
const PIT_CELL = 0.8;
const PIT_RADIUS = vec2f(0.08, 0.22);

// The pits' depth, as a share of `basins`, the least and the most.
const PIT_DEPTH = vec2f(0.3, 0.8);

// --- The coasts, as the open floor sees them ----------------------------------

// The coasts as the open floor sees them at a point: how far it is from
// the nearest, and the way out from them, unit length where one coast is
// plainly the nearest, shorter where the ways from two meet.
export struct Coast {
  distance: f32,
  fall: vec2f,
}

// The coasts are read from the distance map's coarse grid of points, a
// mip this many texels a side at most: every way from p to a coast passes
// points on its way, so p's distance is about the least, over them, of
// theirs plus the way on to p. That holds within the frame and past it
// alike, so the height and seabed maps read one field and meet without a
// seam. The least is softened over the blur (`coastBlur`), and at least
// the points' spacing, so the distance and the way out run on smoothly,
// their creases where the ways from two coasts meet eased off.
const COAST_POINTS = 16u;

// A running soft least: the least so far, the weights against it, their
// weighted totals, and the weighted ways on to p with their lengths.
struct SoftLeast {
  least: f32,
  weight: f32,
  total: f32,
  way: vec2f,
  run: f32,
}

// One grid point `at`, `coast` from the coasts, folded in for p. A new
// least rescales what came before against it, so no weight overflows.
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

// How far the open floor blurs its distance from the coasts, chart units,
// so it falls away smoothly where the ways out from two coasts meet.
fn coastBlur(s: Seascape) -> f32 {
  return COAST_BLUR * s.scale;
}

// The coasts at p, within the frame `grid` or past it, from its distance
// map. The distance is the points' weighted mean, less the half a
// softening it runs over the least by, so it neither sags nor bulges. The
// way out is the points' weighted ways on to p over their weighted
// lengths: the points near p, whose ways point anywhere, count for little.
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

// --- The formations ------------------------------------------------------------

// The canyons at p, `out` past the calm along the way out `fall`: how far
// they cut, chart units. Each starts on the calm's line where a field
// along it crosses zero, and runs out downhill from the coasts; sideways,
// it meanders as it goes.
fn canyonsAt(s: Seascape, p: vec2f, out: f32, fall: vec2f) -> f32 {
  let clear = length(fall);
  let shown = ease(CANYON_CLEAR.x, CANYON_CLEAR.y, clear);
  if (s.canyons <= 0.0 || shown <= 0.0) {
    return 0.0;
  }
  let way = fall / clear;
  let across = vec2f(-way.y, way.x);
  let cell = CANYON_CELL * s.scale;
  // Back along the way out to the calm's line: the same head for the
  // whole of a canyon's run. Out here the ways have fanned apart by
  // `fan` against their spacing there.
  let head = p - out * way;
  let fan = (s.radius + s.calm + out) / (s.radius + s.calm);
  // The meander moves the canyon sideways, chart units, by its own amount
  // for each canyon, and so its head by that much less the fan.
  let run = vec2f(out / (CANYON_RUN * s.scale), 0.0);
  let meander = planarFbm(run + head / cell, 2, 0.5, s.seed, CANYON_MEANDER_SALT);
  let aside = CANYON_MEANDER * s.scale * meander;
  let wandered = head + across * (aside / fan);
  // The field's zero lines are the canyons; its size there, against its
  // slope, is how far across one p is, at the head and then out here.
  let field = planarNoise(wandered / cell, s.seed, CANYON_SALT);
  let offAxis = abs(field) * cell / CANYON_SLOPE * fan;
  let width = CANYON_WIDTH * s.scale + CANYON_WIDEN * out;
  let cut = 1.0 - smoothstep(0.0, 1.0, offAxis / width);
  let deepen = smoothstep(0.0, CANYON_DEEPEN * s.scale, out);
  return s.canyons * cut * deepen * shown;
}

// The sinkholes at q (in formations): each cell holds one or none, a round
// pit with soft walls; the deepest wins.
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

// The fall at w (warped, in formations), `out` past the calm: the descent
// on the swung distance, held back along the sills' crests. Never
// negative: the sills take at most all of it.
fn fallAt(s: Seascape, w: vec2f, out: f32) -> f32 {
  let swingIn = smoothstep(0.0, s.scale, out);
  let swing = planarFbm(w / SWING_CELL, 2, 0.5, s.seed, SWING_SALT);
  let swung = out + SWING * s.scale * s.veer * swingIn * swing;
  let crest = planarRidged(w / SILL_CELL, 2, 0.5, s.seed, SILL_SALT);
  let held = s.sills * pow(crest, SILL_NARROW);
  return s.descent * max(swung, 0.0) * (1.0 - held);
}

// How far the floor sinks under the deep floor at chart point p, `coast`
// from the nearest coast, the way out from the coasts `fall` there
// (`openCoast`): chart units, never negative, so nothing out here rises
// over what the slope reaches. Short of the calm it is 0 exactly.
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
  // The abyssal hills: ridged, so their crests sink least.
  let hills = s.hills * (1.0 - planarRidged(w / HILL_CELL, 2, 0.5, s.seed, HILL_SALT));
  // The faults: the floor beyond each wandering line dropped.
  let faultLine = planarFbm(w / FAULT_CELL + FAULT_OFFSET, 2, 0.5, s.seed, FAULT_SALT);
  let fault = s.faults * smoothstep(-FAULT_EDGE, FAULT_EDGE, faultLine);
  let landform = (basin + trough + hills) * s.basins + pitsAt(s, w);
  let canyons = canyonsAt(s, p, out, fall);
  return grown * (fallAt(s, w, out) + landform + fault + canyons);
}

// `ground` sunk by `sink` (seascapeSink, scaled by how far the open sea's
// floor has taken over) under the deep floor, `floorDepth` deep: only ever
// deeper, by the stepped sink's depth under the deep floor. The height and
// seabed maps both sink their floor so, so they meet at the frame's edge.
export fn sunkGround(s: Seascape, ground: f32, sink: f32, floorDepth: f32) -> f32 {
  let stepped = -steppedFloor(s, sink, floorDepth);
  return ground - max(stepped - floorDepth, 0.0);
}

// The floor `sink` under the deep floor, `floorDepth` deep, cut into
// steps: chart units, under sea level. No sink is the deep floor exactly.
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
