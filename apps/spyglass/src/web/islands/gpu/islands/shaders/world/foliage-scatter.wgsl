// The foliage's placement (world-foliage.ts `settle`), once per plan and
// per zoning, height or light map: never in the frame.
//
// `cs_planned` first stands the trees the plan names (street trees, the
// shrine grove, the coastal pines, garden trees) on the ground, one thread
// a tree, wherever the plan put them: they may stand on reserved ground,
// as a garden tree does inside its lot.
//
// `cs_place` then scatters over a jittered grid on the land, a candidate
// for a tree and one for a shrub in every cell. A tree is kept by the
// zoning map's tree density, gathered into copses by a patch noise where
// the density is low and left solid where it is a grove; its trunk keeps
// clear of reserved ground by a ring, so none stands on a road or inside a
// lot. A shrub is kept by the shrub density, and on open ground in
// patches, and may hug a road's or a wall's edge. The species follows the
// ground: pines where trees are thick near the coast, cedars in a grove's
// heart, broadleaf trees elsewhere.
//
// Both append through an atomic tally into one buffer for the trees and
// one for the shrubs, each capped. `cs_finalize` writes the three draws'
// arguments, each count clamped to its buffer, and the counts the shadow
// draw reads; the CPU reads the tallies back only to grow a buffer that
// overflowed (world-foliage.ts `FOLIAGE_CAP`).
import { planarFbm, planarHash } from "../../../../shaders/noise/planar.wgsl";
import { scatterCandidate, scatterClumps, scatterKeep } from "../../../../shaders/scatter/scatter.wgsl";

struct Scatter {
  // The maps' square: its corner and side, chart units.
  origin: vec2f,
  side: f32,
  // A candidate cell, chart units, and how many a side.
  cell: f32,
  cells: u32,
  // The most trees and shrubs the buffers hold.
  treeCap: u32,
  shrubCap: u32,
  // How many trees the plan names.
  planned: u32,
}

@group(0) @binding(0) var<uniform> params: Scatter;
// r the ground's height; g how far inland of the coast (maps.ts `height`).
@group(0) @binding(1) var height: texture_2d<f32>;
// normal.x, normal.z, occlusion, sun.
@group(0) @binding(2) var light: texture_2d<f32>;
// r the coast's signed distance, negative on land.
@group(0) @binding(3) var distance: texture_2d<f32>;
// r reserved, g tree density, b shrub density, a open ground (maps.ts
// `zoning`).
@group(0) @binding(4) var zoning: texture_2d<f32>;
@group(0) @binding(5) var linear: sampler;
// Four vec4f an instance (`packInstance`).
@group(0) @binding(6) var<storage, read_write> trees: array<vec4f>;
@group(0) @binding(7) var<storage, read_write> shrubs: array<vec4f>;
// The trees placed, then the shrubs, before the caps.
@group(0) @binding(8) var<storage, read_write> tallies: array<atomic<u32>, 2>;
// A vec4f a planned tree (world-foliage.ts `packPlanned`): where it
// stands, its kind and its crown's radius.
@group(0) @binding(9) var<storage, read> planned: array<vec4f>;
// Four u32 a draw: the trees, the shrubs, the shadows.
@group(0) @binding(10) var<storage, read_write> args: array<u32, 12>;
// The trees and the shrubs drawn, for the shadow draw.
@group(0) @binding(11) var<storage, read_write> counts: array<u32, 2>;

// The species (foliage.wgsl, the same names).
const BROADLEAF = 0u;
const CEDAR = 1u;
const PINE = 2u;
const SHRUB = 3u;

// The plan's tree kinds (world-foliage.ts `PLANNED_KINDS`).
const STREET = 0u;
const GROVE = 1u;
const PLANNED_PINE = 2u;
const GARDEN = 3u;

// vec4f an instance.
const INSTANCE_STRIDE = 4u;

// Vertices a tree and a shrub (foliage.wgsl `TREE_VERTICES`,
// `SHRUB_VERTICES`), and the cells of a shadow's patch.
const TREE_VERTICES = 612u;
const SHRUB_VERTICES = 192u;
const SHADOW_VERTICES = 54u;

// Salts 860–865 the candidates (seed 1 a tree's, seed 2 a shrub's);
// 866–868 the copses' three octaves (seed 1) and the shrubs' patches' two
// (seed 2); 867 the tints and 868 the planned trees' rolls, on seeds of
// their own so they share no seed and salt with the noise.
const CANDIDATE_SALT = 860u;
const COPSE_SALT = 866u;
const TINT_SALT = 867u;
const PLANNED_SALT = 868u;
const TREE_SEED = 1u;
const SHRUB_SEED = 2u;
const TREE_TINT_SEED = 3u;
const SHRUB_TINT_SEED = 4u;
const PLANNED_SEED = 6u;
// How far a candidate strays in its cell: under 1 keeps neighbours apart.
const JITTER = 0.85;

// A trunk keeps this far, chart units, from ground any reserved share
// reaches above `TRUNK_RESERVED`; a shrub stands where it is under
// `SHRUB_RESERVED`, so it may lean on a wall.
const TRUNK_CLEAR = 0.9;
const TRUNK_RESERVED = 0.04;
const SHRUB_RESERVED = 0.35;
// How level the ground must be, the normal's y, and how far it may fall
// within `EDGE_REACH` of a trunk: off the cliffs, back from the lip.
const LEVEL = 0.9;
const EDGE_REACH = 1.0;
const EDGE_DROP = 0.6;
// Copses about this many units across, covering this share of sparse
// land, and how much thicker the trees grow in them than the zoning's
// density: about one over the cover, so the land keeps its share of trees
// but gathers them. The tree density at which a grove closes into a solid
// stand.
const COPSE_SCALE = 14.0;
const COPSE_COVER = 0.4;
const COPSE_GAIN = 2.4;
const GROVE_DENSITY = vec2f(0.6, 0.9);
// Shrubs scattered on open ground, a share of candidates, in patches;
// and round the copses' trees, a share of their density.
const OPEN_SHRUBS = 0.12;
const UNDERSTOREY = 0.5;
const SHRUB_PATCH_SCALE = 9.0;
// Pines within this band inland of the coast, chart units, fading out.
const PINE_BAND = vec2f(6.0, 14.0);
// Cedars where the tree density is over this: a grove's heart.
const CEDAR_DENSITY = 0.78;

// Each species' crown radius, chart units, and its height over that
// radius (four metres a unit: broadleaf garden trees 4 to 8 metres, pines
// 10 to 16, grove cedars 15 to 25).
const BROADLEAF_RADIUS = vec2f(0.6, 1.15);
const CEDAR_RADIUS = vec2f(1.0, 1.45);
const PINE_RADIUS = vec2f(0.8, 1.15);
const SHRUB_RADIUS = vec2f(0.22, 0.5);
const BROADLEAF_TALL = vec2f(1.9, 2.4);
const CEDAR_TALL = vec2f(3.2, 3.9);
const PINE_TALL = vec2f(2.9, 3.5);
const SHRUB_TALL = vec2f(1.1, 1.5);
// A pine leans away from the sea by up to this, radians; any tree a little.
const PINE_LEAN = 0.16;
const TREE_LEAN = 0.04;

// One placed plant, as the draws read it (foliage.wgsl `Instance`).
struct Instance {
  // Where its trunk meets the ground, and its crown's radius.
  base: vec3f,
  radius: f32,
  // Its height, its species, a 0–1 variant for its shape, its turn.
  tall: f32,
  species: u32,
  variant: f32,
  turn: f32,
  // −1 to 1 toward yellow or blue, a value scale, the light map's
  // occlusion and sun at its foot.
  hue: f32,
  value: f32,
  occlusion: f32,
  sun: f32,
  // Its lean: a direction on the ground times radians.
  lean: vec2f,
}

fn packInstance(i: Instance) -> array<vec4f, 4> {
  return array<vec4f, 4>(
    vec4f(i.base, i.radius),
    vec4f(i.tall, f32(i.species), i.variant, i.turn),
    vec4f(i.hue, i.value, i.occlusion, i.sun),
    vec4f(i.lean, 0.0, 0.0),
  );
}

fn appendTree(instance: Instance) {
  let index = atomicAdd(&tallies[0], 1u);
  if (index >= params.treeCap) {
    return;
  }
  let packed = packInstance(instance);
  for (var k = 0u; k < INSTANCE_STRIDE; k++) {
    trees[index * INSTANCE_STRIDE + k] = packed[k];
  }
}

fn appendShrub(instance: Instance) {
  let index = atomicAdd(&tallies[1], 1u);
  if (index >= params.shrubCap) {
    return;
  }
  let packed = packInstance(instance);
  for (var k = 0u; k < INSTANCE_STRIDE; k++) {
    shrubs[index * INSTANCE_STRIDE + k] = packed[k];
  }
}

fn uvOf(p: vec2f) -> vec2f {
  return (p - params.origin) / params.side;
}

fn groundAt(p: vec2f) -> f32 {
  return textureSampleLevel(height, linear, uvOf(p), 0.0).r;
}

fn reservedAt(p: vec2f) -> f32 {
  return textureSampleLevel(zoning, linear, uvOf(p), 0.0).r;
}

// Inland of the coast, chart units; negative at sea.
fn inlandAt(p: vec2f) -> f32 {
  return -textureSampleLevel(distance, linear, uvOf(p), 0.0).r;
}

// The way inland, away from the sea: down the coast's distance.
fn inlandWay(p: vec2f) -> vec2f {
  let e = 1.0;
  let gradient = vec2f(
    inlandAt(p + vec2f(e, 0.0)) - inlandAt(p - vec2f(e, 0.0)),
    inlandAt(p + vec2f(0.0, e)) - inlandAt(p - vec2f(0.0, e)),
  );
  let size = length(gradient);
  if (size < 1e-4) {
    return vec2f(0.0);
  }
  return gradient / size;
}

// The most reserved share at a point and on a ring round it.
fn reservedNear(p: vec2f, reach: f32) -> f32 {
  var most = reservedAt(p);
  for (var k = 0u; k < 6u; k++) {
    let a = f32(k) * 1.0471976;
    most = max(most, reservedAt(p + vec2f(cos(a), sin(a)) * reach));
  }
  return most;
}

// How far the ground falls below `h` within a reach of a point: the lip
// of a cliff, or a bank's edge.
fn dropNear(p: vec2f, h: f32, reach: f32) -> f32 {
  var drop = 0.0;
  for (var k = 0u; k < 4u; k++) {
    let a = f32(k) * 1.5707963 + 0.785398;
    drop = max(drop, h - groundAt(p + vec2f(cos(a), sin(a)) * reach));
  }
  return drop;
}

// The ground's normal and the light map's occlusion and sun at a point.
struct Ground {
  h: f32,
  normal: vec3f,
  occlusion: f32,
  sun: f32,
}

fn groundOf(p: vec2f) -> Ground {
  let l = textureSampleLevel(light, linear, uvOf(p), 0.0);
  let normal = vec3f(l.x, sqrt(max(0.0, 1.0 - l.x * l.x - l.y * l.y)), l.y);
  return Ground(groundAt(p), normal, l.z, l.w);
}

// A plant at `p` of a species, its size and look from four rolls: size,
// shape variant, turn, tint.
fn plantAt(p: vec2f, ground: Ground, species: u32, radius: f32, tall: f32, rolls: vec4f, tint: f32) -> Instance {
  var instance: Instance;
  instance.base = vec3f(p.x, ground.h, p.y);
  instance.radius = radius;
  instance.tall = tall * radius;
  instance.species = species;
  instance.variant = rolls.y;
  instance.turn = rolls.z * 6.2831853;
  instance.hue = tint * 2.0 - 1.0;
  instance.value = mix(0.82, 1.14, fract(tint * 7.31 + rolls.x));
  instance.occlusion = ground.occlusion;
  instance.sun = ground.sun;
  let wobble = vec2f(cos(rolls.w * 6.2831853), sin(rolls.w * 6.2831853));
  instance.lean = wobble * TREE_LEAN * rolls.x;
  if (species == PINE) {
    instance.lean += inlandWay(p) * PINE_LEAN * mix(0.4, 1.0, rolls.w);
  }
  return instance;
}

@compute @workgroup_size(64)
fn cs_planned(@builtin(global_invocation_id) id: vec3u) {
  if (id.x >= params.planned) {
    return;
  }
  let tree = planned[id.x];
  let p = tree.xy;
  let kind = u32(tree.z + 0.5);
  let cell = vec2i(i32(id.x), 0);
  let rolls = vec4f(
    planarHash(cell, PLANNED_SEED, PLANNED_SALT),
    planarHash(cell, PLANNED_SEED + 1u, PLANNED_SALT),
    planarHash(cell, PLANNED_SEED + 2u, PLANNED_SALT),
    planarHash(cell, PLANNED_SEED + 3u, PLANNED_SALT),
  );
  let tint = planarHash(cell, PLANNED_SEED + 4u, PLANNED_SALT);
  // A garden tree is now and then a pruned pine; a street tree is a
  // broadleaf trimmed round, the grove's are cedars.
  var species = BROADLEAF;
  var tall = mix(BROADLEAF_TALL.x, BROADLEAF_TALL.y, rolls.x);
  if (kind == GROVE) {
    species = CEDAR;
    tall = mix(CEDAR_TALL.x, CEDAR_TALL.y, rolls.x);
  } else if (kind == PLANNED_PINE || (kind == GARDEN && rolls.w < 0.3)) {
    species = PINE;
    tall = mix(PINE_TALL.x, PINE_TALL.y, rolls.x);
    if (kind == GARDEN) {
      tall *= 0.7;
    }
  } else if (kind == STREET) {
    tall = BROADLEAF_TALL.x;
  }
  appendTree(plantAt(p, groundOf(p), species, tree.w, tall, rolls, tint));
}

@compute @workgroup_size(8, 8)
fn cs_place(@builtin(global_invocation_id) id: vec3u) {
  if (id.x >= params.cells || id.y >= params.cells) {
    return;
  }
  let cell = vec2i(id.xy);
  placeTree(cell);
  placeShrub(cell);
}

// 0 to 1: where the copses gather on sparse land.
fn copsesAt(p: vec2f) -> f32 {
  return scatterClumps(planarFbm(p / COPSE_SCALE, 3, 0.5, TREE_SEED, COPSE_SALT), COPSE_COVER, 0.2);
}

// Off the land, its rim and its slopes.
fn standsOnLand(p: vec2f, ground: Ground) -> bool {
  let heights = textureSampleLevel(height, linear, uvOf(p), 0.0);
  return heights.g > 0.5 && ground.normal.y > LEVEL;
}

fn placeTree(cell: vec2i) {
  let candidate = scatterCandidate(cell, JITTER, TREE_SEED, CANDIDATE_SALT);
  let p = params.origin + candidate.point * params.cell;
  let zone = textureSampleLevel(zoning, linear, uvOf(p), 0.0);
  let rolls = candidate.rolls;
  // Cheap tests first: most cells hold no tree.
  if (zone.g <= 0.0 || rolls.x >= zone.g * COPSE_GAIN) {
    return;
  }
  let ground = groundOf(p);
  if (!standsOnLand(p, ground)) {
    return;
  }
  // Copses with clearings where trees are sparse; a grove closes solid.
  let solid = smoothstep(GROVE_DENSITY.x, GROVE_DENSITY.y, zone.g);
  let density = zone.g * mix(copsesAt(p) * COPSE_GAIN, 1.0, solid);
  if (!scatterKeep(density, rolls.x)) {
    return;
  }
  if (reservedNear(p, TRUNK_CLEAR) > TRUNK_RESERVED || dropNear(p, ground.h, EDGE_REACH) > EDGE_DROP) {
    return;
  }
  let inland = inlandAt(p);
  let coastal = 1.0 - smoothstep(PINE_BAND.x, PINE_BAND.y, inland);
  let tint = planarHash(cell, TREE_TINT_SEED, TINT_SALT);
  // A grove's trees are biggest in its heart, smaller toward its edge.
  let heart = mix(0.8, 1.15, zone.g);
  let size = rolls.z * rolls.y;
  if (coastal * zone.g > fract(rolls.y * 5.0) * 0.5) {
    let radius = mix(PINE_RADIUS.x, PINE_RADIUS.y, size) * heart;
    appendTree(plantAt(p, ground, PINE, radius, mix(PINE_TALL.x, PINE_TALL.y, rolls.w), rolls, tint));
    return;
  }
  if (zone.g > CEDAR_DENSITY) {
    let radius = mix(CEDAR_RADIUS.x, CEDAR_RADIUS.y, size) * heart;
    appendTree(plantAt(p, ground, CEDAR, radius, mix(CEDAR_TALL.x, CEDAR_TALL.y, rolls.w), rolls, tint));
    return;
  }
  let radius = mix(BROADLEAF_RADIUS.x, BROADLEAF_RADIUS.y, size) * heart;
  appendTree(plantAt(p, ground, BROADLEAF, radius, mix(BROADLEAF_TALL.x, BROADLEAF_TALL.y, rolls.w), rolls, tint));
}

fn placeShrub(cell: vec2i) {
  let candidate = scatterCandidate(cell, JITTER, SHRUB_SEED, CANDIDATE_SALT);
  let p = params.origin + candidate.point * params.cell;
  let zone = textureSampleLevel(zoning, linear, uvOf(p), 0.0);
  let rolls = candidate.rolls;
  let patches = scatterClumps(planarFbm(p / SHRUB_PATCH_SCALE, 2, 0.5, SHRUB_SEED, COPSE_SALT), 0.35, 0.2);
  let density = zone.b + zone.a * OPEN_SHRUBS * patches + zone.g * UNDERSTOREY * copsesAt(p);
  if (!scatterKeep(density, rolls.x) || zone.r > SHRUB_RESERVED) {
    return;
  }
  let ground = groundOf(p);
  if (!standsOnLand(p, ground)) {
    return;
  }
  let tint = planarHash(cell, SHRUB_TINT_SEED, TINT_SALT);
  let radius = mix(SHRUB_RADIUS.x, SHRUB_RADIUS.y, rolls.z);
  appendShrub(plantAt(p, ground, SHRUB, radius, mix(SHRUB_TALL.x, SHRUB_TALL.y, rolls.w), rolls, tint));
}

@compute @workgroup_size(1)
fn cs_finalize() {
  let treeCount = min(atomicLoad(&tallies[0]), params.treeCap);
  let shrubCount = min(atomicLoad(&tallies[1]), params.shrubCap);
  args[0] = TREE_VERTICES;
  args[1] = treeCount;
  args[2] = 0u;
  args[3] = 0u;
  args[4] = SHRUB_VERTICES;
  args[5] = shrubCount;
  args[6] = 0u;
  args[7] = 0u;
  args[8] = SHADOW_VERTICES;
  args[9] = treeCount + shrubCount;
  args[10] = 0u;
  args[11] = 0u;
  counts[0] = treeCount;
  counts[1] = shrubCount;
}
