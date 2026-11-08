// The coasts map: one layer per island, each the exact signed distance to
// that island's own coast alone (negative on its land), over the maps'
// frame at the coasts map's own resolution. The banks read every island's
// distance from it (maps/height.wgsl), where the distance map holds only
// the nearest's. One pass per layer; `island` is the layer's. Every ring
// of the island's coast polygons counts, inside decided even-odd over all
// of them, as the distance map decides it.
import { MapFrame, texelCenter } from "./frame.wgsl";

struct CoastsParams {
  frame: MapFrame,
  island: u32,
  offset: vec2u,
}

// One coast polygon of an island: its rings' segments (a range of
// `segments`, outer ring and holes), and their bounds as (min x, min y,
// max x, max y).
struct Piece {
  start: u32,
  count: u32,
  bounds: vec4f,
}

@group(0) @binding(0) var<uniform> params: CoastsParams;
// Per island: the range of its pieces in `pieces`.
@group(0) @binding(1) var<storage, read> islands: array<vec2u>;
@group(0) @binding(2) var<storage, read> pieces: array<Piece>;
// One segment per record: (a.x, a.y, b.x, b.y), rings closed explicitly.
@group(0) @binding(3) var<storage, read> segments: array<vec4f>;

const FAR = 3.0e38;
// An island with no coast is this far from everywhere: past any reach, and
// within half floats.
const NOWHERE = 6.0e4;

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

// Whether a ray from p toward +x crosses segment ab, the segment's span in
// y half-open so a vertex on the ray counts once.
fn rayCrosses(p: vec2f, a: vec2f, b: vec2f) -> bool {
  if ((a.y > p.y) == (b.y > p.y)) {
    return false;
  }
  return a.x + (p.y - a.y) * (b.x - a.x) / (b.y - a.y) > p.x;
}

@fragment
fn fs_main(@builtin(position) position: vec4f) -> @location(0) vec4f {
  let p = texelCenter(params.frame, vec2u(floor(position.xy)) - params.offset);
  let range = islands[params.island];

  // The piece whose bounds are nearest first: its distance then culls the
  // others by their bounds alone.
  var first = 0u;
  var firstGap = FAR;
  for (var k = 0u; k < range.y; k++) {
    let gap = outsideBox(p, pieces[range.x + k].bounds);
    if (gap < firstGap) {
      first = k;
      firstGap = gap;
    }
  }

  var nearest = FAR;
  var inside = false;
  for (var k = 0u; k < range.y; k++) {
    let piece = pieces[range.x + (first + k) % range.y];
    let gap = outsideBox(p, piece.bounds);
    // Outside its bounds and farther than the best so far: neither nearer
    // nor containing.
    if (gap * gap > nearest) {
      continue;
    }
    let end = piece.start + piece.count;
    for (var s = piece.start; s < end; s++) {
      let segment = segments[s];
      nearest = min(nearest, squaredDistanceToSegment(p, segment.xy, segment.zw));
      if (gap == 0.0 && rayCrosses(p, segment.xy, segment.zw)) {
        inside = !inside;
      }
    }
  }

  let d = select(sqrt(nearest), NOWHERE, range.y == 0u);
  return vec4f(select(d, -d, inside), 0.0, 0.0, 1.0);
}
