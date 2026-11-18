import { ICOSPHERE_VERTICES_0, icosphereCorner } from "../../../../../shaders/geometry/icosphere.wgsl";
import { planarNoise } from "../../../../../shaders/noise/planar.wgsl";
import { scatterFade, scatterFrame, scatterPixels } from "../../../../../shaders/scatter/scatter.wgsl";
import { INSTANCE_STRIDE, Instance, SHELL, STACK, unpackInstance } from "./instance.wgsl";

struct Props {
  viewProjection: mat4x4f,
  sun: vec3f,
  sunStrength: f32,
  sunColor: vec3f,
  skyStrength: f32,
  skyColor: vec3f,
  shadowStrength: f32,
  seaFill: vec3f,
  time: f32,
  rock: vec3f,
  fadeStart: f32,
  viewport: vec2f,
  fadeEnd: f32,
  rings: f32,
  foam: vec3f,
  side: f32,
  origin: vec2f,
  occlusion: f32,
  occlusionSun: f32,
}

@group(0) @binding(0) var<uniform> props: Props;
@group(0) @binding(1) var<storage, read> instances: array<vec4f>;
@group(0) @binding(2) var light: texture_2d<f32>;
@group(0) @binding(3) var linear: sampler;

const NOWHERE = vec4f(0.0, 0.0, -2.0, 1.0);
const SHAPE_SALT = 807u;
const FINE_PIXELS = 7.0;

const PEBBLES = array<vec3f, 4>(
  vec3f(0.52, 0.52, 0.5), vec3f(0.64, 0.6, 0.54), vec3f(0.4, 0.42, 0.43), vec3f(0.72, 0.66, 0.58),
);
const SHELLS = array<vec3f, 4>(
  vec3f(0.96, 0.9, 0.8), vec3f(0.95, 0.78, 0.74), vec3f(0.93, 0.62, 0.5), vec3f(0.98, 0.94, 0.86),
);

fn instanceAt(index: u32) -> Instance {
  let at = index * INSTANCE_STRIDE;
  return unpackInstance(instances[at], instances[at + 1u], instances[at + 2u]);
}

fn shaped(inst: Instance, d: vec3f) -> vec3f {
  let lumps = planarNoise(d.xz * 1.7 + d.y * 0.9 + inst.variant * 31.0, 1u, SHAPE_SALT);
  if (inst.kind == SHELL) {
    let ribs = 1.0 + 0.12 * abs(sin(7.0 * atan2(d.z, d.x)));
    return vec3f(d.x * ribs, max(d.y, 0.0) * inst.height, d.z * 0.8 * ribs);
  }
  if (inst.kind == STACK) {
    let up = 0.5 + 0.5 * d.y;
    let taper = mix(1.0, 0.6, up * up) * (1.0 + 0.2 * lumps);
    return vec3f(d.x * taper, up * inst.height - 0.5, d.z * taper);
  }
  let r = 1.0 + 0.18 * lumps;
  return vec3f(d.x * r, (d.y * r + 0.35) * inst.height, d.z * r * 0.8);
}

fn albedo(inst: Instance) -> vec3f {
  let pick = u32(inst.variant * 3.999);
  if (inst.kind == SHELL) {
    return SHELLS[pick];
  }
  if (inst.kind == STACK) {
    return props.rock * mix(0.85, 1.1, inst.variant);
  }
  return PEBBLES[pick];
}

struct BodyOut {
  @builtin(position) position: vec4f,
  @location(0) color: vec3f,
}

@vertex
fn vs_body(@builtin(vertex_index) vertex: u32, @builtin(instance_index) index: u32) -> BodyOut {
  var out: BodyOut;
  out.position = NOWHERE;
  let inst = instanceAt(index);
  let pixels = scatterPixels(props.viewProjection, inst.base, inst.radius, props.viewport);
  let fade = scatterFade(pixels, props.fadeStart, props.fadeEnd);
  let level = select(0u, 1u, pixels > FINE_PIXELS);
  if (fade <= 0.0 || (level == 0u && vertex >= ICOSPHERE_VERTICES_0)) {
    return out;
  }
  let triangle = vertex / 3u;
  let a = shaped(inst, icosphereCorner(triangle, 0u, level));
  let b = shaped(inst, icosphereCorner(triangle, 1u, level));
  let c = shaped(inst, icosphereCorner(triangle, 2u, level));
  let corners = array<vec3f, 3>(a, b, c);
  let frame = scatterFrame(inst.ground, select(1.0, 0.0, inst.kind == STACK), inst.turn);
  let p = corners[vertex % 3u];
  let world = inst.base + frame * (p * inst.radius * fade);
  out.position = props.viewProjection * vec4f(world, 1.0);

  var face = normalize(cross(b - a, c - a));
  face = select(-face, face, dot(face, a + b + c) >= 0.0);
  let normal = normalize(frame * face);
  let uv = (inst.base.xz - props.origin) / props.side;
  let l = textureSampleLevel(light, linear, uv, 0.0);
  let foot = mix(0.55, 1.0, smoothstep(-0.2, 0.6, p.y / max(inst.height, 0.1)));
  let ao = pow(l.z, props.occlusion);
  let fill = mix(props.seaFill, props.skyColor, normal.y * 0.5 + 0.5) * props.skyStrength * ao * foot;
  let shadow = select(l.w, mix(l.w, 1.0, smoothstep(0.0, 1.0, world.y)), inst.kind == STACK);
  let direct = props.sunColor * max(dot(normal, props.sun), 0.0) * mix(1.0, shadow, props.shadowStrength) * props.sunStrength * mix(1.0, ao, props.occlusionSun);
  out.color = albedo(inst) * (fill + direct);
  return out;
}

@fragment
fn fs_body(in: BodyOut) -> @location(0) vec4f {
  return vec4f(in.color, 1.0);
}

const RING_LIFT = 0.03;
const RING_REACH = 2.6;
const RING_PERIOD = 3.5;

struct RingOut {
  @builtin(position) position: vec4f,
  @location(0) offset: vec2f,
  @location(1) @interpolate(flat) radius: f32,
  @location(2) @interpolate(flat) phase: f32,
}

@vertex
fn vs_ring(@builtin(vertex_index) vertex: u32, @builtin(instance_index) index: u32) -> RingOut {
  var out: RingOut;
  out.position = NOWHERE;
  let inst = instanceAt(index);
  if (inst.kind != STACK || props.rings <= 0.0) {
    return out;
  }
  let up = saturate((inst.depth + 0.5 * inst.radius) / (inst.height * inst.radius));
  let radius = inst.radius * mix(1.0, 0.55, up);
  let corners = array<vec2f, 6>(vec2f(-1.0, -1.0), vec2f(1.0, -1.0), vec2f(1.0, 1.0), vec2f(-1.0, -1.0), vec2f(1.0, 1.0), vec2f(-1.0, 1.0));
  out.offset = corners[vertex] * radius * RING_REACH;
  let world = vec3f(inst.base.x + out.offset.x, RING_LIFT, inst.base.z + out.offset.y);
  out.position = props.viewProjection * vec4f(world, 1.0);
  out.radius = radius;
  out.phase = inst.variant;
  return out;
}

@fragment
fn fs_ring(in: RingOut) -> @location(0) vec4f {
  let r = length(in.offset);
  let reach = in.radius * RING_REACH;
  let collar = 1.0 - smoothstep(0.08, 0.3, (r - in.radius) / in.radius);
  var spread = 0.0;
  for (var k = 0u; k < 2u; k++) {
    let t = fract(props.time / RING_PERIOD + in.phase + 0.5 * f32(k));
    let at = mix(in.radius, reach, t);
    let width = 0.06 * in.radius * (1.0 + t);
    spread = max(spread, (1.0 - smoothstep(0.0, width, abs(r - at))) * (1.0 - t));
  }
  let foam = max(collar, 0.8 * spread) * props.rings;
  if (foam < 0.5 || r < in.radius * 0.9 || r > reach) {
    discard;
  }
  return vec4f(props.foam, 1.0);
}
