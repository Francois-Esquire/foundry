import { planarHash, planarNoise } from "../../../../shaders/noise/planar.wgsl";

struct Props {
  viewProjection: mat4x4f,
  sun: vec3f,
  sunStrength: f32,
  sunColor: vec3f,
  skyStrength: f32,
  skyColor: vec3f,
  shadowStrength: f32,
  seaFill: vec3f,
  occlusion: f32,
  origin: vec2f,
  side: f32,
  occlusionSun: f32,
  viewport: vec2f,
}

@group(0) @binding(0) var<uniform> props: Props;
@group(0) @binding(1) var<storage, read> instances: array<vec4f>;
@group(0) @binding(2) var<storage, read> shrubs: array<vec4f>;
@group(0) @binding(3) var<storage, read> counts: array<u32, 2>;
@group(0) @binding(4) var height: texture_2d<f32>;
@group(0) @binding(5) var linear: sampler;

const BROADLEAF = 0u;
const CEDAR = 1u;
const PINE = 2u;
const SHRUB = 3u;

const TRUNK_SIDES = 6u;
const TRUNK_VERTICES = 36u;
const SEGMENTS = 8u;
const BANDS = 5u;
const BLOB_TRIANGLES = 64u;
const BLOB_VERTICES = 192u;
const CONE_TRIANGLES = 16u;

const TAU = 6.2831853;
const PI = 3.14159265;

const LEAF_SALT = 869u;
const LUMP = 0.16;
const BEND = 0.55;
const FACET = 0.12;
const WRAP = 0.5;
const SINK = 0.3;

const BROADLEAF_COLOR = vec3f(0.14, 0.25, 0.05);
const CEDAR_COLOR = vec3f(0.065, 0.13, 0.06);
const PINE_COLOR = vec3f(0.07, 0.125, 0.065);
const SHRUB_COLOR = vec3f(0.12, 0.23, 0.05);
const BARK_COLOR = vec3f(0.13, 0.09, 0.06);
const YELLOW_TINT = vec3f(1.18, 1.06, 0.62);
const BLUE_TINT = vec3f(0.82, 0.98, 1.14);
const LIT_WARM = vec3f(1.1, 1.05, 0.85);
const SHADE_COOL = vec3f(0.9, 0.97, 1.08);

const SHADOW_CELLS = 3u;
const SHADOW_LIFT = 0.04;
const SHADOW_DARK = 0.42;
const SHADOW_SOFT = 0.45;
const CONTACT_DARK = 0.25;

const QUAD = array<vec2u, 6>(vec2u(0u, 0u), vec2u(1u, 0u), vec2u(1u, 1u), vec2u(0u, 0u), vec2u(1u, 1u), vec2u(0u, 1u));

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

fn instanceOf(a: vec4f, b: vec4f, c: vec4f, d: vec4f) -> Instance {
  return Instance(a.xyz, a.w, b.x, u32(b.y + 0.5), b.z, b.w, c.x, c.y, c.z, c.w, d.xy);
}

fn plantAt(index: u32) -> Instance {
  let k = index * 4u;
  return instanceOf(instances[k], instances[k + 1u], instances[k + 2u], instances[k + 3u]);
}

fn shrubAt(index: u32) -> Instance {
  let k = index * 4u;
  return instanceOf(shrubs[k], shrubs[k + 1u], shrubs[k + 2u], shrubs[k + 3u]);
}

struct Crown {
  middle: vec3f,
  across: f32,
  half: f32,
}

fn crownOf(i: Instance) -> Crown {
  let r = i.radius;
  let h = i.tall;
  if (i.species == CEDAR) {
    return Crown(vec3f(0.0, 0.56 * h, 0.0), r, 0.44 * h);
  }
  if (i.species == PINE) {
    return Crown(vec3f(0.0, 0.62 * h, 0.0), r, 0.38 * h);
  }
  if (i.species == SHRUB) {
    return Crown(vec3f(0.0, 0.42 * h, 0.0), r, 0.5 * h);
  }
  return Crown(vec3f(0.0, h - 0.85 * r, 0.0), 1.15 * r, 0.85 * r);
}

struct Blob {
  middle: vec3f,
  radii: vec3f,
}

struct Tier {
  foot: vec3f,
  radius: f32,
  rise: f32,
}

fn rollsOf(i: Instance) -> vec2f {
  return fract(vec2f(i.variant * 13.73, i.variant * 29.17));
}

fn blobOf(i: Instance, slot: u32) -> Blob {
  let r = i.radius;
  let h = i.tall;
  let rolls = rollsOf(i);
  if (i.species == SHRUB) {
    return Blob(vec3f(0.0, 0.42 * h, 0.0), vec3f(r, 0.55 * h, r * mix(0.8, 1.0, rolls.x)));
  }
  if (i.species == CEDAR) {
    let heights = vec3f(0.36, 0.6, 0.82);
    let widths = vec3f(1.0, 0.78, 0.5);
    let halves = vec3f(0.28, 0.24, 0.2);
    let w = widths[slot] * r;
    let side = vec2f(cos(i.variant * TAU), sin(i.variant * TAU)) * 0.08 * r * f32(slot);
    return Blob(vec3f(side.x, heights[slot] * h, side.y), vec3f(w, halves[slot] * h, w));
  }
  let crown = crownOf(i);
  if (slot == 0u) {
    return Blob(crown.middle, vec3f(r, 0.82 * r, r) * mix(0.9, 1.0, rolls.x));
  }
  let a = i.variant * TAU + f32(slot - 1u) * mix(2.2, 3.0, rolls.y);
  let reach = select(0.5, 0.45, slot == 2u) * r;
  let rise = select(-0.2, 0.25, slot == 2u) * r;
  let size = select(0.72, 0.62, slot == 2u) * r * mix(0.85, 1.1, rolls.x);
  return Blob(crown.middle + vec3f(cos(a) * reach, rise, sin(a) * reach), vec3f(size, 0.85 * size, size));
}

fn tierOf(i: Instance, slot: u32, tier: u32) -> Tier {
  let r = i.radius;
  let h = i.tall;
  let t = f32(tier);
  let rolls = rollsOf(i);
  if (slot == 0u) {
    let wander = vec2f(cos(i.variant * 40.0 + t * 2.1), sin(i.variant * 40.0 + t * 2.1)) * 0.06 * r * t;
    return Tier(vec3f(wander.x, (0.46 + 0.13 * t) * h, wander.y), r * (1.0 - 0.21 * t), (0.17 - 0.01 * t) * h);
  }
  if (tier == 3u || (slot == 2u && rolls.y < 0.35)) {
    return Tier(vec3f(0.0), 0.0, 0.0);
  }
  let a = i.variant * TAU + f32(slot - 1u) * mix(2.2, 3.4, rolls.x);
  let reach = mix(0.7, 0.9, rolls.y) * r;
  let y = select(0.34, 0.5, slot == 2u) * h + 0.06 * h * t;
  return Tier(vec3f(cos(a) * reach, y, sin(a) * reach), 0.55 * r * (1.0 - 0.3 * t), 0.1 * h);
}

struct Corner {
  p: vec3f,
  normal: vec3f,
}

fn lumpOf(ring: u32, segment: u32, seed: u32) -> f32 {
  let h = planarHash(vec2i(i32(ring), i32(segment)), seed, LEAF_SALT);
  return 1.0 + LUMP * (h - 0.5);
}

fn spherePoint(ring: u32, segment: u32) -> vec3f {
  let theta = PI * f32(ring) / f32(BANDS);
  let phi = TAU * (f32(segment % SEGMENTS) + 0.5 * f32(ring % 2u)) / f32(SEGMENTS);
  return vec3f(sin(theta) * cos(phi), cos(theta), sin(theta) * sin(phi));
}

fn blobIndex(triangle: u32, k: u32) -> vec2u {
  if (triangle < SEGMENTS) {
    let s = triangle;
    let corners = array<vec2u, 3>(vec2u(0u, 0u), vec2u(1u, s), vec2u(1u, s + 1u));
    return corners[k];
  }
  let last = BLOB_TRIANGLES - SEGMENTS;
  if (triangle >= last) {
    let s = triangle - last;
    let corners = array<vec2u, 3>(vec2u(BANDS, 0u), vec2u(BANDS - 1u, s + 1u), vec2u(BANDS - 1u, s));
    return corners[k];
  }
  let m = triangle - SEGMENTS;
  let band = 1u + m / (2u * SEGMENTS);
  let w = m % (2u * SEGMENTS);
  let s = w / 2u;
  let a = vec2u(band, s);
  let b = vec2u(band + 1u, s + (band % 2u));
  let c = vec2u(band + 1u, s + (band % 2u) + 1u);
  let d = vec2u(band, s + 1u);
  if (w % 2u == 0u) {
    let corners = array<vec2u, 3>(a, b, c);
    return corners[k];
  }
  let corners = array<vec2u, 3>(a, c, d);
  return corners[k];
}

fn blobCorner(blob: Blob, triangle: u32, k: u32, seed: u32) -> Corner {
  let index = blobIndex(triangle, k);
  let pole = index.x == 0u || index.x == BANDS;
  let segment = select(index.y % SEGMENTS, 0u, pole);
  let unit = spherePoint(index.x, segment);
  let lump = select(lumpOf(index.x, segment, seed), 1.0, pole);
  return Corner(blob.middle + unit * blob.radii * lump, normalize(unit / max(blob.radii, vec3f(1e-4))));
}

fn coneCorner(tier: Tier, triangle: u32, k: u32, seed: u32) -> Corner {
  let underneath = triangle >= SEGMENTS;
  let s = triangle % SEGMENTS;
  let first = select(s, s + 1u, underneath);
  let second = select(s + 1u, s, underneath);
  if (k == 0u) {
    if (underneath) {
      return Corner(tier.foot + vec3f(0.0, 0.3 * tier.rise, 0.0), vec3f(0.0, -1.0, 0.0));
    }
    return Corner(tier.foot + vec3f(0.0, tier.rise, 0.0), vec3f(0.0, 1.0, 0.0));
  }
  let segment = select(second, first, k == 1u) % SEGMENTS;
  let phi = TAU * f32(segment) / f32(SEGMENTS);
  let out = vec2f(cos(phi), sin(phi));
  let lump = lumpOf(BANDS + 1u, segment, seed);
  let r = tier.radius * lump;
  let p = tier.foot + vec3f(out.x * r, -0.15 * tier.rise, out.y * r);
  let normal = normalize(vec3f(out.x * tier.rise, r, out.y * tier.rise));
  return Corner(p, select(normal, vec3f(out.x * 0.3, -1.0, out.y * 0.3), underneath));
}

fn slotCorner(i: Instance, slot: u32, triangle: u32, k: u32, seed: u32) -> Corner {
  if (i.species == PINE) {
    let tier = tierOf(i, slot, triangle / CONE_TRIANGLES);
    return coneCorner(tier, triangle % CONE_TRIANGLES, k, seed + slot);
  }
  return blobCorner(blobOf(i, slot), triangle, k, seed + slot);
}

fn trunkOf(i: Instance) -> vec2f {
  let r = i.radius;
  if (i.species == CEDAR) {
    return vec2f(0.5 * i.tall, 0.09 * r + 0.04);
  }
  if (i.species == PINE) {
    return vec2f(0.74 * i.tall, 0.08 * r + 0.04);
  }
  return vec2f(crownOf(i).middle.y, 0.09 * r + 0.035);
}

fn trunkCorner(i: Instance, vertex: u32) -> Corner {
  let trunk = trunkOf(i);
  let side = vertex / 6u;
  let q = QUAD[vertex % 6u];
  let phi = TAU * f32(side + q.x) / f32(TRUNK_SIDES);
  let top = q.y == 1u;
  let r = select(trunk.y, trunk.y * 0.55, top);
  let y = select(-SINK, trunk.x, top);
  let out = vec2f(cos(phi), sin(phi));
  return Corner(vec3f(out.x * r, y, out.y * r), normalize(vec3f(out.x, 0.25, out.y)));
}

struct PlantOut {
  @builtin(position) position: vec4f,
  @location(0) normal: vec3f,
  @location(1) world: vec3f,
  @location(2) shade: vec2f,
  @location(3) @interpolate(flat) albedo: vec3f,
  @location(4) @interpolate(flat) light: vec3f,
}

fn spinOf(turn: f32) -> mat2x2f {
  return mat2x2f(cos(turn), sin(turn), -sin(turn), cos(turn));
}

fn leafColor(i: Instance) -> vec3f {
  var base = BROADLEAF_COLOR;
  if (i.species == CEDAR) {
    base = CEDAR_COLOR;
  } else if (i.species == PINE) {
    base = PINE_COLOR;
  } else if (i.species == SHRUB) {
    base = SHRUB_COLOR;
  }
  let tint = select(mix(vec3f(1.0), BLUE_TINT, -i.hue), mix(vec3f(1.0), YELLOW_TINT, i.hue), i.hue > 0.0);
  return base * mix(vec3f(1.0), tint, 0.6) * i.value;
}

fn emit(i: Instance, c: Corner, normal: vec3f, bark: bool) -> PlantOut {
  let spin = spinOf(i.turn);
  let xz = i.base.xz + spin * c.p.xz + i.lean * max(c.p.y, 0.0);
  let world = vec3f(xz.x, i.base.y + c.p.y, xz.y);
  let n = spin * normal.xz;
  let crown = crownOf(i);
  var out: PlantOut;
  out.position = props.viewProjection * vec4f(world, 1.0);
  out.normal = vec3f(n.x, normal.y, n.y);
  out.world = world;
  let offset = (c.p - crown.middle) / vec3f(crown.across, crown.half, crown.across);
  out.shade = vec2f(saturate(1.0 - length(offset)), saturate(0.5 - 0.5 * offset.y));
  out.albedo = select(leafColor(i), BARK_COLOR, bark);
  out.light = vec3f(i.occlusion, i.sun, select(0.0, 1.0, bark));
  return out;
}

fn leafVertex(i: Instance, slot: u32, triangle: u32, k: u32) -> PlantOut {
  let seed = u32(i.variant * 65536.0);
  let a = slotCorner(i, slot, triangle, 0u, seed);
  let b = slotCorner(i, slot, triangle, 1u, seed);
  let c = slotCorner(i, slot, triangle, 2u, seed);
  let corners = array<Corner, 3>(a, b, c);
  let corner = corners[k];
  let crown = crownOf(i);
  var face = cross(b.p - a.p, c.p - a.p);
  let centroid = (a.p + b.p + c.p) / 3.0;
  let outward = centroid - crown.middle;
  if (dot(face, outward) < 0.0) {
    face = -face;
  }
  let faceted = normalize(face + vec3f(0.0, 1e-6, 0.0));
  let away = normalize(corner.p - crown.middle + vec3f(0.0, 1e-4, 0.0));
  let soft = normalize(mix(corner.normal, faceted, FACET));
  return emit(i, corner, normalize(mix(soft, away, BEND)), false);
}

@vertex
fn vs_tree(@builtin(vertex_index) vertex: u32, @builtin(instance_index) index: u32) -> PlantOut {
  let i = plantAt(index);
  if (vertex < TRUNK_VERTICES) {
    let c = trunkCorner(i, vertex);
    return emit(i, c, c.normal, true);
  }
  let v = vertex - TRUNK_VERTICES;
  let slot = v / BLOB_VERTICES;
  let w = v % BLOB_VERTICES;
  return leafVertex(i, slot, w / 3u, w % 3u);
}

@vertex
fn vs_shrub(@builtin(vertex_index) vertex: u32, @builtin(instance_index) index: u32) -> PlantOut {
  let i = plantAt(index);
  return leafVertex(i, 0u, vertex / 3u, vertex % 3u);
}

@fragment
fn fs_plant(in: PlantOut) -> @location(0) vec4f {
  let normal = normalize(in.normal);
  let ao = pow(max(in.light.x, 1e-3), props.occlusion);
  let shadow = mix(1.0, in.light.y, props.shadowStrength);
  let sunShare = mix(1.0, ao, props.occlusionSun);
  let sky = mix(props.seaFill, props.skyColor, normal.y * 0.5 + 0.5) * props.skyStrength;
  if (in.light.z > 0.5) {
    let foot = mix(0.5, 0.85, in.shade.y);
    let direct = props.sunColor * max(dot(normal, props.sun), 0.0) * shadow * props.sunStrength * sunShare;
    return vec4f(in.albedo * (sky * ao * foot + direct * 0.5), 1.0);
  }
  let inner = in.shade.x;
  let low = in.shade.y;
  let cover = mix(1.0, 0.55, inner) * mix(1.0, 0.6, low * low);
  let wrap = saturate((dot(normal, props.sun) + WRAP) / (1.0 + WRAP));
  let direct = props.sunColor * wrap * shadow * props.sunStrength * sunShare * mix(1.0, 0.6, inner);
  let fill = sky * ao * cover;
  let mottle = 1.0 + 0.12 * planarNoise(in.world.xz * 2.3 + in.world.y * 1.7, 1u, LEAF_SALT);
  let albedo = in.albedo * mottle * mix(SHADE_COOL, LIT_WARM, wrap);
  return vec4f(albedo * (fill + direct), 1.0);
}


struct ShadowOut {
  @builtin(position) position: vec4f,
  @location(0) offset: vec2f,
  @location(1) @interpolate(flat) falls: vec4f,
  @location(2) @interpolate(flat) sun: f32,
}

fn groundAt(xz: vec2f) -> f32 {
  return textureSampleLevel(height, linear, (xz - props.origin) / props.side, 0.0).r;
}

@vertex
fn vs_shadow(@builtin(vertex_index) vertex: u32, @builtin(instance_index) index: u32) -> ShadowOut {
  var i: Instance;
  if (index < counts[0]) {
    i = plantAt(index);
  } else {
    i = shrubAt(index - counts[0]);
  }
  let crown = crownOf(i);
  let fall = -props.sun.xz / max(props.sun.y, 0.2);
  let reach = length(fall);
  let along = select(vec2f(1.0, 0.0), fall / max(reach, 1e-4), reach > 1e-4);
  let across = vec2f(-along.y, along.x);
  let centre = crown.middle.y * reach;
  let halfLength = crown.across + crown.half * reach;
  let halfWidth = crown.across;
  let soft = SHADOW_SOFT * crown.across;
  let low = vec2f(min(-crown.across, centre - halfLength) - soft, -halfWidth - soft);
  let high = vec2f(max(crown.across, centre + halfLength) + soft, halfWidth + soft);
  let cell = vertex / 6u;
  let corner = QUAD[vertex % 6u];
  let g = vec2f(vec2u(cell % SHADOW_CELLS, cell / SHADOW_CELLS) + corner) / f32(SHADOW_CELLS);
  let offset = mix(low, high, g);
  let xz = i.base.xz + along * offset.x + across * offset.y;
  var out: ShadowOut;
  out.position = props.viewProjection * vec4f(xz.x, groundAt(xz) + SHADOW_LIFT, xz.y, 1.0);
  out.offset = offset;
  out.falls = vec4f(centre, halfLength, halfWidth, crown.across);
  out.sun = i.sun;
  return out;
}

@fragment
fn fs_shadow(in: ShadowOut) -> @location(0) vec4f {
  let q = vec2f((in.offset.x - in.falls.x) / in.falls.y, in.offset.y / in.falls.z);
  let d = length(q);
  let shade = 1.0 - smoothstep(1.0 - SHADOW_SOFT, 1.0 + SHADOW_SOFT * 0.5, d);
  let contact = 1.0 - smoothstep(0.0, 0.7 * in.falls.w, length(in.offset));
  let alpha = (SHADOW_DARK * shade * mix(0.35, 1.0, in.sun) + CONTACT_DARK * contact) * props.shadowStrength;
  if (alpha <= 0.002) {
    discard;
  }
  return vec4f(0.0, 0.0, 0.0, min(alpha, 0.8));
}
