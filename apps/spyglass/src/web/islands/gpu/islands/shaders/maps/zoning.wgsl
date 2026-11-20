import { MapFrame } from "./frame.wgsl";

struct ZoningParams {
  frame: MapFrame,
  ease: f32,
  feather: f32,
  reach: f32,
}

@group(0) @binding(0) var<uniform> params: ZoningParams;
@group(0) @binding(1) var<storage, read> polygons: array<vec4f>;
@group(0) @binding(2) var<storage, read> points: array<vec2f>;
@group(0) @binding(3) var<storage, read> segments: array<vec4f>;

struct Polygon {
  first: u32,
  count: u32,
  growth: vec2f,
  low: vec2f,
  high: vec2f,
  ring: vec2f,
}

fn polygonAt(index: u32) -> Polygon {
  let a = polygons[index * 3u];
  let b = polygons[index * 3u + 1u];
  let c = polygons[index * 3u + 2u];
  return Polygon(u32(a.x), u32(a.y), a.zw, b.xy, b.zw, c.xy);
}

struct ShapeOut {
  @builtin(position) position: vec4f,
  @location(0) world: vec2f,
  @location(1) @interpolate(flat) index: u32,
}

fn corner(vertex: u32) -> vec2f {
  var corners = array<vec2f, 6>(
    vec2f(0.0, 0.0), vec2f(1.0, 0.0), vec2f(0.0, 1.0),
    vec2f(0.0, 1.0), vec2f(1.0, 0.0), vec2f(1.0, 1.0),
  );
  return corners[vertex];
}

fn mapClip(p: vec2f) -> vec4f {
  let side = params.frame.texel * f32(params.frame.resolution);
  let uv = (p - params.frame.origin) / side;
  return vec4f(uv.x * 2.0 - 1.0, 1.0 - uv.y * 2.0, 0.0, 1.0);
}

@vertex
fn vs_polygon(
  @builtin(vertex_index) vertex: u32,
  @builtin(instance_index) instance: u32,
) -> ShapeOut {
  let polygon = polygonAt(instance);
  let low = polygon.low - params.reach;
  let high = polygon.high + params.reach;
  let world = mix(low, high, corner(vertex));
  var out: ShapeOut;
  out.position = mapClip(world);
  out.world = world;
  out.index = instance;
  return out;
}

fn polygonDistance(p: vec2f, polygon: Polygon) -> f32 {
  var nearest = 1e20;
  var inside = false;
  var previous = points[polygon.first + polygon.count - 1u];
  for (var k = 0u; k < polygon.count; k += 1u) {
    let point = points[polygon.first + k];
    let edge = previous - point;
    let toward = p - point;
    let length2 = dot(edge, edge);
    if (length2 > 0.0) {
      let foot = toward - edge * saturate(dot(toward, edge) / length2);
      nearest = min(nearest, dot(foot, foot));
    }
    let spans = (point.y > p.y) != (previous.y > p.y);
    if (spans) {
      let x = point.x + (p.y - point.y) * edge.x / edge.y;
      if (p.x < x) {
        inside = !inside;
      }
    }
    previous = point;
  }
  return select(1.0, -1.0, inside) * sqrt(nearest);
}

fn zoneCover(d: f32) -> f32 {
  let width = max(params.feather, params.frame.texel);
  return saturate(0.5 - d / width);
}

fn reserveCover(d: f32) -> f32 {
  let ease = max(params.ease, params.frame.texel);
  return 1.0 - smoothstep(0.0, ease, d);
}

@fragment
fn fs_zone(in: ShapeOut) -> @location(0) vec4f {
  let polygon = polygonAt(in.index);
  let cover = zoneCover(polygonDistance(in.world, polygon));
  return vec4f(0.0, polygon.growth * cover, cover);
}

@fragment
fn fs_ring(in: ShapeOut) -> @location(0) vec4f {
  let polygon = polygonAt(in.index);
  let d = polygonDistance(in.world, polygon);
  let half = max(polygon.ring.y, params.frame.texel);
  let weight = 1.0 - smoothstep(0.0, half, abs(d - polygon.ring.x));
  return vec4f(0.0, polygon.growth * weight, 0.0);
}

@fragment
fn fs_reserve(in: ShapeOut) -> @location(0) vec4f {
  let polygon = polygonAt(in.index);
  let cover = reserveCover(polygonDistance(in.world, polygon));
  return vec4f(cover, 0.0, 0.0, cover);
}

struct SegmentOut {
  @builtin(position) position: vec4f,
  @location(0) local: vec2f,
  @location(1) @interpolate(flat) span: f32,
  @location(2) @interpolate(flat) half: f32,
}

@vertex
fn vs_road(
  @builtin(vertex_index) vertex: u32,
  @builtin(instance_index) instance: u32,
) -> SegmentOut {
  let ends = segments[instance * 2u];
  let half = segments[instance * 2u + 1u].x;
  let run = ends.zw - ends.xy;
  let span = length(run);
  let along = select(vec2f(1.0, 0.0), run / span, span > 0.0);
  let across = vec2f(-along.y, along.x);
  let reach = half + params.reach;
  let c = corner(vertex);
  let local = vec2f(mix(-reach, span + reach, c.x), mix(-reach, reach, c.y));
  var out: SegmentOut;
  out.position = mapClip(ends.xy + along * local.x + across * local.y);
  out.local = local;
  out.span = span;
  out.half = half;
  return out;
}

@fragment
fn fs_road(in: SegmentOut) -> @location(0) vec4f {
  let fromCentre = length(vec2f(in.local.x - clamp(in.local.x, 0.0, in.span), in.local.y));
  let cover = reserveCover(fromCentre - in.half);
  return vec4f(cover, 0.0, 0.0, cover);
}
