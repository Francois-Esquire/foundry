// The zoning map (WORLD.md layer 2): what the world plan (world.ts) does
// with the ground, baked once per plan by instanced draws into the map.
// r is reserved: 1 under a road, a parcel or a building, easing to 0 over
// about a unit past its edge, so the turf stops short of it softly. g is
// tree density, b shrub and garden density, a open ground: how far the
// island is left wild.
//
// Three kinds of draw, in this order, each with its own blend
// (maps.ts `encodeZoning`):
// 1. Zones, a draw a kind, broad wild land first and the town's own last:
//    each lays its growth over what is there by its cover, as a
//    premultiplied over. g and b come from the fragment; a, the open
//    ground, from the draw's blend constant, which is the kind's.
// 2. Rings along outlines (a hedge round a parcel, trees round a field),
//    taking the larger of their density and the map's.
// 3. What is reserved: parcels and buildings as polygons, then roads as
//    capsules along their centrelines. Each adds its cover to r and takes
//    as much away from g, b and a, so nothing grows on it.
//
// The map is coarse (about 0.85 units a texel on Foundry): it carries soft
// fields only. Crisp edges are the surfaces' and structures' own geometry.
import { MapFrame } from "./frame.wgsl";

struct ZoningParams {
  frame: MapFrame,
  // Chart units past a reserved shape's edge over which r eases to 0.
  ease: f32,
  // Chart units across a zone's edge over which its growth fades in.
  feather: f32,
  // Chart units a polygon's quad reaches past its points' bounds: more than
  // any ease, feather or ring.
  reach: f32,
}

@group(0) @binding(0) var<uniform> params: ZoningParams;
// Three vec4f a polygon (zoning.ts `packZoning`): its first point and point
// count, and the trees and shrubs it grows; the bounds of its points; for
// a ring, how far outside the outline it runs and its half width.
@group(0) @binding(1) var<storage, read> polygons: array<vec4f>;
// Every polygon's outline, one after another.
@group(0) @binding(2) var<storage, read> points: array<vec2f>;
// Two vec4f a road segment: its ends; its half width.
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
  // The chart point.
  @location(0) world: vec2f,
  @location(1) @interpolate(flat) index: u32,
}

// Two triangles over the unit square, 0 to 1.
fn corner(vertex: u32) -> vec2f {
  var corners = array<vec2f, 6>(
    vec2f(0.0, 0.0), vec2f(1.0, 0.0), vec2f(0.0, 1.0),
    vec2f(0.0, 1.0), vec2f(1.0, 0.0), vec2f(1.0, 1.0),
  );
  return corners[vertex];
}

// Chart point to clip space over the map.
fn mapClip(p: vec2f) -> vec4f {
  let side = params.frame.texel * f32(params.frame.resolution);
  let uv = (p - params.frame.origin) / side;
  // Map row 0 is the frame's origin, chart y down: clip y runs the other way.
  return vec4f(uv.x * 2.0 - 1.0, 1.0 - uv.y * 2.0, 0.0, 1.0);
}

// A polygon's quad: the bounds of its points, `reach` past them.
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

// Signed distance from p to the polygon's outline, negative inside. The
// outline may wind either way; a repeated point is skipped.
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
    // Crossing number: does a ray from p toward +x cross this edge?
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

// How much of a zone's growth reaches p: whole well inside its outline,
// fading out across its edge.
fn zoneCover(d: f32) -> f32 {
  let width = max(params.feather, params.frame.texel);
  return saturate(0.5 - d / width);
}

// How reserved p is, `d` past a reserved shape's edge: whole inside and on
// the edge, eased to nothing `ease` beyond it, never over less than a texel.
fn reserveCover(d: f32) -> f32 {
  let ease = max(params.ease, params.frame.texel);
  return 1.0 - smoothstep(0.0, ease, d);
}

// A zone: its trees and shrubs premultiplied by its cover; its open ground
// is the draw's blend constant, scaled by the cover in alpha.
@fragment
fn fs_zone(in: ShapeOut) -> @location(0) vec4f {
  let polygon = polygonAt(in.index);
  let cover = zoneCover(polygonDistance(in.world, polygon));
  return vec4f(0.0, polygon.growth * cover, cover);
}

// A ring along an outline: the most at its middle line, `ring.x` outside
// the outline (inside when negative), none `ring.y` either side of it.
@fragment
fn fs_ring(in: ShapeOut) -> @location(0) vec4f {
  let polygon = polygonAt(in.index);
  let d = polygonDistance(in.world, polygon);
  let half = max(polygon.ring.y, params.frame.texel);
  let weight = 1.0 - smoothstep(0.0, half, abs(d - polygon.ring.x));
  return vec4f(0.0, polygon.growth * weight, 0.0);
}

// A reserved polygon: r its cover, which the blend takes from g, b and a.
@fragment
fn fs_reserve(in: ShapeOut) -> @location(0) vec4f {
  let polygon = polygonAt(in.index);
  let cover = reserveCover(polygonDistance(in.world, polygon));
  return vec4f(cover, 0.0, 0.0, cover);
}

struct SegmentOut {
  @builtin(position) position: vec4f,
  // Chart units from the segment's start: x along it, y across it.
  @location(0) local: vec2f,
  @location(1) @interpolate(flat) span: f32,
  @location(2) @interpolate(flat) half: f32,
}

// A road segment's quad: from `reach` before its start to `reach` past its
// end, `reach` past its sides. Neighbouring segments overlap at their round
// caps, so a road bends without a gap.
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

// A road: reserved across its width, round at its ends, eased off past
// its edges like a parcel.
@fragment
fn fs_road(in: SegmentOut) -> @location(0) vec4f {
  let fromCentre = length(vec2f(in.local.x - clamp(in.local.x, 0.0, in.span), in.local.y));
  let cover = reserveCover(fromCentre - in.half);
  return vec4f(cover, 0.0, 0.0, cover);
}
