import { planarFbm, planarHash } from "../../../../shaders/noise/planar.wgsl";
import { scatterCandidate, scatterClumps, scatterKeep } from "../../../../shaders/scatter/scatter.wgsl";

struct Scatter {
  origin: vec2f,
  side: f32,
  cell: f32,
  cells: u32,
  treeCap: u32,
  shrubCap: u32,
  planned: u32,
}

@group(0) @binding(0) var<uniform> params: Scatter;
@group(0) @binding(1) var height: texture_2d<f32>;
@group(0) @binding(2) var light: texture_2d<f32>;
@group(0) @binding(3) var distance: texture_2d<f32>;
@group(0) @binding(4) var zoning: texture_2d<f32>;
@group(0) @binding(5) var linear: sampler;
@group(0) @binding(6) var<storage, read_write> trees: array<vec4f>;
@group(0) @binding(7) var<storage, read_write> shrubs: array<vec4f>;
@group(0) @binding(8) var<storage, read_write> tallies: array<atomic<u32>, 2>;
@group(0) @binding(9) var<storage, read> planned: array<vec4f>;
@group(0) @binding(10) var<storage, read_write> args: array<u32, 12>;
@group(0) @binding(11) var<storage, read_write> counts: array<u32, 2>;

const BROADLEAF = 0u;
const CEDAR = 1u;
const PINE = 2u;
const SHRUB = 3u;

const STREET = 0u;
const GROVE = 1u;
const PLANNED_PINE = 2u;
const GARDEN = 3u;

const INSTANCE_STRIDE = 4u;

const TREE_VERTICES = 612u;
const SHRUB_VERTICES = 192u;
const SHADOW_VERTICES = 54u;

const CANDIDATE_SALT = 860u;
const COPSE_SALT = 866u;
const TINT_SALT = 867u;
const PLANNED_SALT = 868u;
const TREE_SEED = 1u;
const SHRUB_SEED = 2u;
const TREE_TINT_SEED = 3u;
const SHRUB_TINT_SEED = 4u;
const PLANNED_SEED = 6u;
const JITTER = 0.85;

const TRUNK_CLEAR = 0.9;
const TRUNK_RESERVED = 0.04;
const SHRUB_RESERVED = 0.35;
const LEVEL = 0.9;
const EDGE_REACH = 1.0;
const EDGE_DROP = 0.6;
const COPSE_SCALE = 14.0;
const COPSE_COVER = 0.4;
const COPSE_GAIN = 2.4;
const GROVE_DENSITY = vec2f(0.6, 0.9);
const OPEN_SHRUBS = 0.12;
const UNDERSTOREY = 0.5;
const SHRUB_PATCH_SCALE = 9.0;
const PINE_BAND = vec2f(6.0, 14.0);
const CEDAR_DENSITY = 0.78;

const BROADLEAF_RADIUS = vec2f(0.6, 1.15);
const CEDAR_RADIUS = vec2f(1.0, 1.45);
const PINE_RADIUS = vec2f(0.8, 1.15);
const SHRUB_RADIUS = vec2f(0.22, 0.5);
const BROADLEAF_TALL = vec2f(1.9, 2.4);
const CEDAR_TALL = vec2f(3.2, 3.9);
const PINE_TALL = vec2f(2.9, 3.5);
const SHRUB_TALL = vec2f(1.1, 1.5);
const PINE_LEAN = 0.16;
const TREE_LEAN = 0.04;

struct Instance {
  base: vec3f,
  radius: f32,
  tall: f32,
  species: u32,
  variant: f32,
  turn: f32,
  hue: f32,
  value: f32,
  occlusion: f32,
  sun: f32,
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

fn inlandAt(p: vec2f) -> f32 {
  return -textureSampleLevel(distance, linear, uvOf(p), 0.0).r;
}

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

fn reservedNear(p: vec2f, reach: f32) -> f32 {
  var most = reservedAt(p);
  for (var k = 0u; k < 6u; k++) {
    let a = f32(k) * 1.0471976;
    most = max(most, reservedAt(p + vec2f(cos(a), sin(a)) * reach));
  }
  return most;
}

fn dropNear(p: vec2f, h: f32, reach: f32) -> f32 {
  var drop = 0.0;
  for (var k = 0u; k < 4u; k++) {
    let a = f32(k) * 1.5707963 + 0.785398;
    drop = max(drop, h - groundAt(p + vec2f(cos(a), sin(a)) * reach));
  }
  return drop;
}

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

fn copsesAt(p: vec2f) -> f32 {
  return scatterClumps(planarFbm(p / COPSE_SCALE, 3, 0.5, TREE_SEED, COPSE_SALT), COPSE_COVER, 0.2);
}

fn standsOnLand(p: vec2f, ground: Ground) -> bool {
  let heights = textureSampleLevel(height, linear, uvOf(p), 0.0);
  return heights.g > 0.5 && ground.normal.y > LEVEL;
}

fn placeTree(cell: vec2i) {
  let candidate = scatterCandidate(cell, JITTER, TREE_SEED, CANDIDATE_SALT);
  let p = params.origin + candidate.point * params.cell;
  let zone = textureSampleLevel(zoning, linear, uvOf(p), 0.0);
  let rolls = candidate.rolls;
  if (zone.g <= 0.0 || rolls.x >= zone.g * COPSE_GAIN) {
    return;
  }
  let ground = groundOf(p);
  if (!standsOnLand(p, ground)) {
    return;
  }
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
