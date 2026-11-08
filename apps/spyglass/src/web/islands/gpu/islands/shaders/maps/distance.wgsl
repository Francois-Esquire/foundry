// The distance map, and the islands map in the same pass: for every texel,
// the exact signed distance to the nearest coast (negative on land) and the
// island it belongs to. Every ring of every coast polygon counts, holes
// included, and inside is decided even-odd per island: the shape exactly.
import { MapFrame, texelCenter } from "./frame.wgsl";

struct DistanceParams {
  frame: MapFrame,
  islandCount: u32,
}

// One island's coast: its segments' range in `segments`, and their bounds
// as (min x, min y, max x, max y).
struct Coast {
  start: u32,
  count: u32,
  bounds: vec4f,
}

@group(0) @binding(0) var<uniform> params: DistanceParams;
@group(0) @binding(1) var<storage, read> coasts: array<Coast>;
// One segment per record: (a.x, a.y, b.x, b.y), rings closed explicitly.
@group(0) @binding(2) var<storage, read> segments: array<vec4f>;

struct Texel {
  // Signed distance in chart units; g is reserved.
  @location(0) distance: vec4f,
  // The island's index + 1: the one containing the texel on land, the one
  // with the nearest coast at sea. 0 for a chart with no islands.
  @location(1) owner: u32,
}

const FAR = 3.0e38;

// How far p lies outside a box, 0 inside it.
fn outsideBox(p: vec2f, box: vec4f) -> f32 {
  return length(max(max(box.xy - p, p - box.zw), vec2f(0.0)));
}

fn squaredDistanceToSegment(p: vec2f, a: vec2f, b: vec2f) -> f32 {
  let along = b - a;
  let offset = p - a;
  let t = clamp(dot(offset, along) / max(dot(along, along), 1e-30), 0.0, 1.0);
  let gap = offset - along * t;
  return dot(gap, gap);
}

// Whether a ray from p toward +x crosses segment ab. The segment's span in
// y is half-open, so a ring vertex lying on the ray is counted once.
fn rayCrosses(p: vec2f, a: vec2f, b: vec2f) -> bool {
  if ((a.y > p.y) == (b.y > p.y)) {
    return false;
  }
  let x = a.x + (p.y - a.y) * (b.x - a.x) / (b.y - a.y);
  return x > p.x;
}

struct Measure {
  squaredDistance: f32,
  inside: bool,
}

// The nearest point of an island's coast, and whether p is inside it. Only
// a point within the coast's bounds can be inside, so only then does it
// count crossings.
fn measure(coast: Coast, p: vec2f, mayBeInside: bool) -> Measure {
  var nearest = FAR;
  var inside = false;
  let end = coast.start + coast.count;
  for (var s = coast.start; s < end; s++) {
    let segment = segments[s];
    nearest = min(nearest, squaredDistanceToSegment(p, segment.xy, segment.zw));
    if (mayBeInside && rayCrosses(p, segment.xy, segment.zw)) {
      inside = !inside;
    }
  }
  return Measure(nearest, inside);
}

@fragment
fn fs_main(@builtin(position) position: vec4f) -> Texel {
  let p = texelCenter(params.frame, vec2u(floor(position.xy)));
  let count = params.islandCount;

  // Start with the island whose bounds are nearest: its distance then culls
  // most of the others by their bounds alone.
  var first = 0u;
  var firstGap = FAR;
  for (var i = 0u; i < count; i++) {
    let gap = outsideBox(p, coasts[i].bounds);
    if (gap < firstGap) {
      first = i;
      firstGap = gap;
    }
  }

  var nearest = FAR;
  var owner = 0u;
  var container = 0u;
  for (var k = 0u; k < count; k++) {
    let i = (first + k) % count;
    let coast = coasts[i];
    let gap = outsideBox(p, coast.bounds);
    // Outside the bounds and farther than the best so far: neither nearer
    // nor containing.
    if (gap * gap > nearest) {
      continue;
    }
    let m = measure(coast, p, gap == 0.0);
    if (m.squaredDistance < nearest) {
      nearest = m.squaredDistance;
      owner = i + 1u;
    }
    if (m.inside) {
      container = i + 1u;
    }
  }

  if (count == 0u) {
    // No coast anywhere: open sea, as far as the frame reaches.
    let side = params.frame.texel * f32(params.frame.resolution);
    return Texel(vec4f(side, 0.0, 0.0, 1.0), 0u);
  }
  let d = sqrt(nearest);
  let land = container != 0u;
  return Texel(vec4f(select(d, -d, land), 0.0, 0.0, 1.0), select(owner, container, land));
}
