import { MapFrame, texelCenter } from "./frame.wgsl";

struct DistanceParams {
  frame: MapFrame,
  islandCount: u32,
}

struct Coast {
  start: u32,
  count: u32,
  bounds: vec4f,
}

@group(0) @binding(0) var<uniform> params: DistanceParams;
@group(0) @binding(1) var<storage, read> coasts: array<Coast>;
@group(0) @binding(2) var<storage, read> segments: array<vec4f>;

struct Texel {
  @location(0) distance: vec4f,
  @location(1) owner: u32,
}

const FAR = 3.0e38;

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
    let side = params.frame.texel * f32(params.frame.resolution);
    return Texel(vec4f(side, 0.0, 0.0, 1.0), 0u);
  }
  let d = sqrt(nearest);
  let land = container != 0u;
  return Texel(vec4f(select(d, -d, land), 0.0, 0.0, 1.0), select(owner, container, land));
}
