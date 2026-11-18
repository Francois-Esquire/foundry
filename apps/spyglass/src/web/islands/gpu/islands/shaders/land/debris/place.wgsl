import { planarFbm } from "../../../../../shaders/noise/planar.wgsl";
import { scatterCandidate, scatterClumps, scatterKeep } from "../../../../../shaders/scatter/scatter.wgsl";
import { ARGS_BODIES, ARGS_RINGS, Instance, INSTANCE_STRIDE, packInstance, PEBBLE, RING_VERTICES, SHELL, STACK } from "./instance.wgsl";
import { ICOSPHERE_VERTICES_1 } from "../../../../../shaders/geometry/icosphere.wgsl";

struct Place {
  origin: vec2f,
  side: f32,
  cell: f32,
  cells: u32,
  cap: u32,
  top: f32,
  sandHeight: f32,
  pebbles: f32,
  shells: f32,
  stacks: f32,
  size: f32,
}

@group(0) @binding(0) var<uniform> params: Place;
@group(0) @binding(1) var height: texture_2d<f32>;
@group(0) @binding(2) var light: texture_2d<f32>;
@group(0) @binding(3) var distance: texture_2d<f32>;
@group(0) @binding(4) var paint: texture_2d<f32>;
@group(0) @binding(5) var linear: sampler;
@group(0) @binding(6) var<storage, read_write> instances: array<vec4f>;
@group(0) @binding(7) var<storage, read_write> tally: atomic<u32>;
@group(0) @binding(8) var<storage, read_write> args: array<u32, 8>;

const CANDIDATE_SALT = 800u;
const PATCH_SALT = 806u;
const JITTER = 0.9;
const PATCH_CELLS = 18.0;
const PATCH_COVER = 0.55;

const PEBBLE_RADIUS = vec2f(0.35, 0.8);
const SHELL_RADIUS = vec2f(0.45, 0.75);
const STACK_RADIUS = vec2f(1.8, 3.2);
const STACK_RISE = vec2f(6.0, 13.0);
const STACK_OFFSHORE = 8.0;
const STACK_LEVEL = 0.985;

fn append(instance: Instance) {
  let index = atomicAdd(&tally, 1u);
  if (index >= params.cap) {
    return;
  }
  let packed = packInstance(instance);
  for (var k = 0u; k < INSTANCE_STRIDE; k++) {
    instances[index * INSTANCE_STRIDE + k] = packed[k];
  }
}

@compute @workgroup_size(8, 8)
fn cs_place(@builtin(global_invocation_id) id: vec3u) {
  if (id.x >= params.cells || id.y >= params.cells) {
    return;
  }
  let candidate = scatterCandidate(vec2i(id.xy), JITTER, 1u, CANDIDATE_SALT);
  let p = params.origin + candidate.point * params.cell;
  let uv = (p - params.origin) / params.side;
  let heights = textureSampleLevel(height, linear, uv, 0.0);
  if (heights.g >= 0.0) {
    return;
  }
  let h = heights.r;
  let depth = -h;
  let l = textureSampleLevel(light, linear, uv, 0.0);
  let normal = vec3f(l.x, sqrt(max(0.0, 1.0 - l.x * l.x - l.y * l.y)), l.y);
  let coast = textureSampleLevel(distance, linear, uv, 0.0).r;
  let steep = select(0.0, textureSampleLevel(paint, linear, uv, 0.0).a, coast < 2.0 * params.top + 16.0);
  let patches = scatterClumps(planarFbm(p / (PATCH_CELLS * params.cell), 3, 0.5, 1u, PATCH_SALT), PATCH_COVER, 0.2);
  let rolls = candidate.rolls;

  var instance: Instance;
  instance.base = vec3f(p.x, h, p.y);
  instance.ground = normal;
  instance.turn = rolls.w * 6.2831853;
  instance.variant = fract(rolls.y * 7.0);
  instance.depth = max(depth, 0.0);

  let plate = depth > 0.6 * params.top && depth < 3.0 * params.top && coast > STACK_OFFSHORE && normal.y > STACK_LEVEL;
  if (plate && scatterKeep(params.stacks * (1.0 - steep), rolls.x)) {
    instance.kind = STACK;
    instance.radius = mix(STACK_RADIUS.x, STACK_RADIUS.y, rolls.z) * params.size;
    instance.height = (depth + mix(STACK_RISE.x, STACK_RISE.y, rolls.y)) / instance.radius;
    append(instance);
    return;
  }
  let shallow = h > -2.5 * params.top && h < params.sandHeight;
  if (!shallow) {
    return;
  }
  let edge = h > -0.5 * params.top;
  let lip = 1.0 - smoothstep(0.93, 0.99, normal.y);
  let keepShell = edge && rolls.y < 0.35;
  var density = params.pebbles * mix(0.3, 1.0, lip) * patches;
  if (keepShell) {
    density = params.shells * patches;
  }
  if (!scatterKeep(density * (1.0 - steep), rolls.x)) {
    return;
  }
  instance.kind = select(PEBBLE, SHELL, keepShell);
  let range = select(PEBBLE_RADIUS, SHELL_RADIUS, keepShell);
  instance.radius = mix(range.x, range.y, rolls.z * rolls.z) * params.size;
  instance.height = select(mix(0.4, 0.75, rolls.y), 0.45, keepShell);
  append(instance);
}

@compute @workgroup_size(1)
fn cs_finalize() {
  let count = min(atomicLoad(&tally), params.cap);
  args[ARGS_BODIES] = ICOSPHERE_VERTICES_1;
  args[ARGS_BODIES + 1u] = count;
  args[ARGS_BODIES + 2u] = 0u;
  args[ARGS_BODIES + 3u] = 0u;
  args[ARGS_RINGS] = RING_VERTICES;
  args[ARGS_RINGS + 1u] = count;
  args[ARGS_RINGS + 2u] = 0u;
  args[ARGS_RINGS + 3u] = 0u;
}
