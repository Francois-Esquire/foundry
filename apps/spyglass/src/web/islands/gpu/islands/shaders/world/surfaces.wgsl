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
@group(0) @binding(1) var<storage, read> ribbons: array<vec4f>;
@group(0) @binding(2) var<storage, read> roads: array<vec4f>;
@group(0) @binding(3) var<storage, read> gaps: array<vec4f>;
@group(0) @binding(4) var<storage, read> pads: array<vec4f>;
@group(0) @binding(5) var<storage, read> parcels: array<vec4f>;
@group(0) @binding(6) var<storage, read> outlines: array<vec2f>;
@group(0) @binding(8) var light: texture_2d<f32>;
@group(0) @binding(9) var linear: sampler;
@group(0) @binding(10) var<storage, read> ribbonGround: array<f32>;
@group(0) @binding(11) var<storage, read> padGround: array<f32>;

struct DrapeParams {
  origin: vec2f,
  side: f32,
  count: u32,
}

@group(0) @binding(12) var<uniform> drape: DrapeParams;
@group(0) @binding(13) var<storage, read> placed: array<vec4f>;
@group(0) @binding(14) var<storage, read_write> grounds: array<f32>;
@group(0) @binding(15) var height: texture_2d<f32>;

const MAIN = 0u;
const STREET = 1u;
const LANE = 2u;
const PATH = 3u;
const DISC = 4u;
const SCHOOL = 1u;

const LOT = 0u;
const PLAZA = 1u;
const PITCH = 2u;
const PLAYGROUND = 3u;
const TRACK = 4u;
const FIELD = 5u;
const GARDEN = 6u;
const SHRINE = 7u;
const PARKING = 8u;

const MIN_PIXELS = 0.75;
const PROBE = 0.05;
const SHOULDER = 0.2;
const SKIRT = 0.12;
const SHOULDER_DARK = 0.6;

const EDGE_LINE = 0.035;
const MAIN_INSET = 0.1;
const STREET_INSET = 0.07;
const CENTRE_LINE = 0.035;
const DASH_PERIOD = 2.0;
const DASH_ON = 1.25;
const GUTTER = 0.09;
const GUTTER_JOINT = 0.125;
const JOINT = 0.008;
const SCHOOL_STRIP = 0.11;

const ASPHALT = vec3f(0.066, 0.069, 0.074);
const LINE_WHITE = vec3f(0.74, 0.74, 0.7);
const LINE_YELLOW = vec3f(0.55, 0.33, 0.06);
const GUTTER_CONCRETE = vec3f(0.36, 0.35, 0.32);
const SCHOOL_GREEN = vec3f(0.19, 0.4, 0.22);
const PATH_GRAVEL = vec3f(0.25, 0.22, 0.17);
const EARTH = vec3f(0.085, 0.065, 0.045);

const CONCRETE = vec3f(0.3, 0.29, 0.27);
const GRAVEL = vec3f(0.2, 0.185, 0.16);
const SHRINE_GRAVEL = vec3f(0.42, 0.4, 0.35);
const PAVING = vec3f(0.33, 0.3, 0.25);
const PAVING_BORDER = vec3f(0.2, 0.19, 0.18);
const LAWN = vec3f(0.19, 0.29, 0.085);
const SAND = vec3f(0.5, 0.4, 0.24);
const TRACK_RED = vec3f(0.26, 0.085, 0.055);
const CROP = vec3f(0.2, 0.36, 0.07);
const PADDY = vec3f(0.22, 0.4, 0.1);
const BARE_EARTH = vec3f(0.17, 0.12, 0.075);
const SOIL = vec3f(0.09, 0.06, 0.04);
const RUBBER = vec3f(0.12, 0.2, 0.13);

const MARK_LINE = 0.03;
const PITCH_INSET = 0.25;
const TRACK_LANE = 0.3;
const BAY_WIDTH = 0.625;
const BAY_LENGTH = 1.25;
const BAY_LINE = 0.025;

const ASPHALT_SALT = 850u;
const GRAIN_SALT = 851u;
const GRAVEL_SALT = 852u;
const PAVING_SALT = 853u;
const CROP_SALT = 854u;
const SOIL_SALT = 855u;
const PATH_SALT = 856u;
const LOT_SALT = 857u;
const LAWN_SALT = 858u;
const SAND_SALT = 859u;

const VERTEX_SPACING = 1.25;
const SMOOTHING = 0.4;
const BULGE_SPAN = 2.0;

fn drapeAt(xz: vec2f) -> f32 {
  return textureSampleLevel(height, linear, (xz - drape.origin) / drape.side, 0.0).r;
}

fn smoothGround(xz: vec2f) -> f32 {
  var sum = 0.0;
  for (var i = -1; i <= 1; i++) {
    for (var j = -1; j <= 1; j++) {
      sum += drapeAt(xz + vec2f(f32(i), f32(j)) * SMOOTHING);
    }
  }
  return sum / 9.0;
}

@compute @workgroup_size(64)
fn cs_drape(@builtin(global_invocation_id) id: vec3u) {
  if (id.x >= drape.count) {
    return;
  }
  let xz = placed[id.x * 2u].xy;
  let h = smoothGround(xz);
  let scale = pow(0.5 * VERTEX_SPACING / BULGE_SPAN, 2.0);
  var bulge = 0.0;
  let ways = array<vec2f, 4>(vec2f(1.0, 0.0), vec2f(0.0, 1.0), vec2f(0.7071, 0.7071), vec2f(0.7071, -0.7071));
  for (var k = 0u; k < 4u; k++) {
    let o = ways[k] * BULGE_SPAN;
    let chord = 0.5 * (smoothGround(xz + o) + smoothGround(xz - o));
    bulge = max(bulge, (h - chord) * scale);
  }
  grounds[id.x] = h + bulge;
}

fn uvOf(xz: vec2f) -> vec2f {
  return (xz - props.origin) / props.side;
}

fn pixelsAlong(p: vec3f, dir: vec2f) -> f32 {
  let a = props.viewProjection * vec4f(p, 1.0);
  let b = props.viewProjection * vec4f(p + vec3f(dir.x, 0.0, dir.y) * PROBE, 1.0);
  if (a.w <= 1e-4 || b.w <= 1e-4) {
    return 1e6;
  }
  let step = (b.xy / b.w - a.xy / a.w) * 0.5 * props.viewport;
  return max(length(step) / PROBE, 1e-6);
}

fn band(x: f32, low: f32, high: f32, w: f32) -> f32 {
  let width = max(w, 1e-5);
  return saturate((min(high, x + 0.5 * width) - max(low, x - 0.5 * width)) / width);
}

fn stripeRun(x: f32, period: f32, on: f32) -> f32 {
  let n = floor(x / period);
  return n * on + min(x - n * period, on);
}

fn stripes(x: f32, period: f32, on: f32, w: f32) -> f32 {
  let width = max(w, 1e-5);
  return saturate((stripeRun(x + 0.5 * width, period, on) - stripeRun(x - 0.5 * width, period, on)) / width);
}

fn joints(x: f32, period: f32, on: f32, w: f32) -> f32 {
  return stripes(x + 0.5 * on, period, on, w);
}

const QUIET_EASE = 0.8;

fn detail(size: f32, w: f32) -> f32 {
  return 1.0 - smoothstep(0.25 * size, size, w);
}

fn lit(albedo: vec3f, xz: vec2f) -> vec3f {
  let l = textureSampleLevel(light, linear, uvOf(xz), 0.0);
  let normal = vec3f(l.x, sqrt(max(0.0, 1.0 - l.x * l.x - l.y * l.y)), l.y);
  let ao = pow(l.z, props.occlusion);
  let fill = mix(props.seaFill, props.skyColor, normal.y * 0.5 + 0.5) * props.skyStrength * ao;
  let shadow = mix(1.0, l.w, props.shadowStrength);
  let direct = props.sunColor * max(dot(normal, props.sun), 0.0) * shadow * props.sunStrength * mix(1.0, ao, props.occlusionSun);
  return albedo * (fill + direct);
}


struct Road {
  half: f32,
  rank: u32,
  firstGap: u32,
  gaps: u32,
  flags: u32,
  length: f32,
  id: u32,
}

fn roadAt(index: u32) -> Road {
  let a = roads[index * 2u];
  let b = roads[index * 2u + 1u];
  return Road(a.x, u32(a.y), u32(a.z), u32(a.w), u32(b.x), b.y, u32(b.z));
}

struct RoadOut {
  @builtin(position) position: vec4f,
  @location(0) world: vec3f,
  @location(1) ribbon: vec2f,
  @location(2) @interpolate(flat) road: u32,
}

@vertex
fn vs_road(@builtin(vertex_index) vertex: u32) -> RoadOut {
  let a = ribbons[vertex * 2u];
  let b = ribbons[vertex * 2u + 1u];
  let code = u32(b.w + 0.5);
  let road = code / 2u;
  var xz = a.xy;
  var across = a.w;
  let ground = ribbonGround[vertex];
  if (code % 2u == 1u) {
    let half = roads[road * 2u].x;
    let pixels = pixelsAlong(vec3f(xz.x, ground, xz.y), b.xy);
    let reach = max(abs(across), half + MIN_PIXELS / pixels);
    xz += b.xy * (reach - abs(across)) * sign(across);
    across = sign(across) * reach;
  }
  let world = vec3f(xz.x, ground + b.z, xz.y);
  var out: RoadOut;
  out.position = props.viewProjection * vec4f(world, 1.0);
  out.world = world;
  out.ribbon = vec2f(a.z, across);
  out.road = road;
  return out;
}

const FILLET_REACH = 2.0;
const MOUTH_OVERLAP = 0.08;
const FILLET_OVERLAP = 0.06;

struct Fillet {
  cover: f32,
  reach: f32,
}

fn filletAt(q: vec2f, corner: vec2f, along: vec2f, out: vec2f, radius: f32, w: f32) -> Fillet {
  let cosine = clamp(dot(along, out), -0.999, 0.999);
  let halfAngle = 0.5 * acos(cosine);
  let reach = min(radius / tan(halfAngle), FILLET_REACH * radius);
  let r = reach * tan(halfAngle);
  let bisector = normalize(along + out);
  let centre = corner + bisector * (r / sin(halfAngle));
  let p = q - corner;
  let turn = sign(along.x * out.y - along.y * out.x);
  let pastEdge = (along.x * p.y - along.y * p.x) * turn >= 0.0;
  let beforeBranch = (p.x * out.y - p.y * out.x) * turn >= -FILLET_OVERLAP;
  let inside = pastEdge && beforeBranch;
  let near = dot(p, bisector) < reach * cos(halfAngle);
  var cover = 0.0;
  if (inside && near) {
    cover = saturate((length(q - centre) - r) / w + 0.5);
  }
  return Fillet(cover, reach);
}

struct Edges {
  paved: vec2f,
  bare: vec2f,
  quiet: vec2f,
}

fn edgesAt(road: Road, s: f32, a: f32, wa: f32, ws: f32) -> Edges {
  var e = Edges(vec2f(0.0), vec2f(0.0), vec2f(0.0));
  for (var k = 0u; k < road.gaps; k++) {
    let g = gaps[(road.firstGap + k) * 2u];
    let ways = gaps[(road.firstGap + k) * 2u + 1u];
    let side = select(0u, 1u, g.z > 0.0);
    if (g.w > 0.0) {
      let q = vec2f(s, a * g.z - road.half);
      let left = filletAt(q, vec2f(g.x, 0.0), vec2f(-1.0, 0.0), ways.xy, g.w, wa);
      let right = filletAt(q, vec2f(g.y, 0.0), vec2f(1.0, 0.0), ways.zw, g.w, wa);
      let mouth = band(s, g.x, g.y, ws) * band(q.y, -1.0, MOUTH_OVERLAP, wa);
      e.paved[side] = max(e.paved[side], max(mouth, max(left.cover, right.cover)));
      let low = g.x - left.reach;
      let high = g.y + right.reach;
      e.bare[side] = max(e.bare[side], band(s, low, high, ws));
      e.quiet[side] = max(e.quiet[side], band(s, low, high, max(ws, QUIET_EASE)));
    } else {
      e.bare[side] = max(e.bare[side], band(s, g.x, g.y, ws));
      e.quiet[side] = max(e.quiet[side], band(s, g.x, g.y, max(ws, QUIET_EASE)));
    }
  }
  return e;
}

struct Paint {
  color: vec3f,
  cover: f32,
}

fn over(under: Paint, color: vec3f, cover: f32) -> Paint {
  let a = cover + under.cover * (1.0 - cover);
  let c = (color * cover + under.color * under.cover * (1.0 - cover)) / max(a, 1e-4);
  return Paint(c, a);
}

fn asphaltOf(xz: vec2f, w: f32) -> vec3f {
  let patches = planarNoise(xz * 0.3, 1u, ASPHALT_SALT) * 0.08 + planarNoise(xz * 1.3, 1u, GRAIN_SALT) * 0.04;
  let grain = planarNoise(xz * 11.0, 1u, GRAIN_SALT) * 0.06 * detail(0.1, w);
  return ASPHALT * (1.0 + patches + grain);
}

fn gravelOf(base: vec3f, xz: vec2f, w: f32) -> vec3f {
  let stones = planarNoise(xz * 14.0, 1u, GRAVEL_SALT) * 0.14 * detail(0.08, w);
  let drift = planarNoise(xz * 0.9, 1u, PATH_SALT) * 0.08;
  return base * (1.0 + stones + drift);
}

fn furnished(road: Road, color: vec3f, s: f32, a: f32, y: f32, wa: f32, ws: f32, bare: f32) -> vec3f {
  var c = color;
  let keep = 1.0 - bare;
  let h = road.half;
  if (road.rank == MAIN || road.rank == STREET) {
    let inset = select(STREET_INSET, MAIN_INSET, road.rank == MAIN);
    let edge = band(y, h - inset - EDGE_LINE, h - inset, wa) * keep;
    c = mix(c, LINE_WHITE, edge);
  }
  if (road.rank == MAIN) {
    let centre = band(a, -0.5 * CENTRE_LINE, 0.5 * CENTRE_LINE, wa) * stripes(s, DASH_PERIOD, DASH_ON, ws);
    c = mix(c, LINE_YELLOW, centre);
  }
  if (road.rank == LANE) {
    let gutter = band(y, h - GUTTER, h, wa) * keep;
    let joint = joints(s, GUTTER_JOINT, JOINT, ws);
    c = mix(c, GUTTER_CONCRETE * (1.0 - 0.45 * joint), gutter);
    var inner = h - GUTTER;
    if ((road.flags & SCHOOL) != 0u) {
      c = mix(c, SCHOOL_GREEN, band(y, inner - SCHOOL_STRIP, inner, wa) * keep);
      inner -= SCHOOL_STRIP;
    }
    let edge = band(y, inner - 0.02 - EDGE_LINE, inner - 0.02, wa) * keep;
    c = mix(c, LINE_WHITE, edge);
  }
  return c;
}

@fragment
fn fs_road(in: RoadOut) -> @location(0) vec4f {
  let road = roadAt(in.road);
  let s = in.ribbon.x;
  let a = in.ribbon.y;
  let y = abs(a);
  let wa = max(fwidth(a), 1e-5);
  let ws = max(fwidth(s), 1e-5);
  let xz = in.world.xz;
  if (road.rank == DISC) {
    let cover = band(a, -1.0, road.half, wa);
    if (cover <= 0.004) {
      discard;
    }
    return vec4f(lit(asphaltOf(xz, wa), xz), cover);
  }
  let side = select(0u, 1u, a > 0.0);
  let edges = edgesAt(road, s, a, wa, ws);
  let h = road.half;
  var surface: vec3f;
  var cover: f32;
  if (road.rank == PATH) {
    let wander = 0.04 * planarNoise(vec2f(s * 1.7, f32(side) * 13.0 + f32(road.id)), 1u, PATH_SALT);
    let soft = max(wa, 0.05);
    cover = band(a, -(h + wander), h + wander, soft);
    surface = gravelOf(PATH_GRAVEL, xz, wa);
  } else {
    cover = band(a, -h, h, wa);
    surface = furnished(road, asphaltOf(xz, wa), s, a, y, wa, ws, edges.bare[side]);
  }
  cover = max(cover, edges.paved[side]);
  let t = saturate((y - h) / SHOULDER);
  let shoulder = SHOULDER_DARK * (1.0 - t) * (1.0 - t) * (1.0 - edges.quiet[side]) * step(h, y);
  let paint = over(Paint(EARTH, shoulder), surface, cover);
  if (paint.cover <= 0.004) {
    discard;
  }
  return vec4f(lit(paint.color, xz), paint.cover);
}


struct Parcel {
  middle: vec2f,
  x: vec2f,
  z: vec2f,
  half: vec2f,
  kind: u32,
  id: u32,
  first: u32,
  points: u32,
}

fn parcelAt(index: u32) -> Parcel {
  let a = parcels[index * 3u];
  let b = parcels[index * 3u + 1u];
  let c = parcels[index * 3u + 2u];
  return Parcel(a.xy, a.zw, b.xy, b.zw, u32(c.x), u32(c.y), u32(c.z), u32(c.w));
}

struct PadOut {
  @builtin(position) position: vec4f,
  @location(0) world: vec3f,
  @location(1) local: vec2f,
  @location(2) @interpolate(flat) parcel: u32,
}

@vertex
fn vs_pad(@builtin(vertex_index) vertex: u32) -> PadOut {
  let a = pads[vertex * 2u];
  let b = pads[vertex * 2u + 1u];
  let index = u32(b.y + 0.5);
  let parcel = parcelAt(index);
  var xz = a.xy;
  let ground = padGround[vertex];
  if (any(a.zw != vec2f(0.0))) {
    let pixels = pixelsAlong(vec3f(xz.x, ground, xz.y), a.zw);
    xz += a.zw * max(SKIRT, MIN_PIXELS / pixels);
  }
  let world = vec3f(xz.x, ground + b.x, xz.y);
  var out: PadOut;
  out.position = props.viewProjection * vec4f(world, 1.0);
  out.world = world;
  let d = xz - parcel.middle;
  out.local = vec2f(dot(d, parcel.x), dot(d, parcel.z));
  out.parcel = index;
  return out;
}

fn outlineDistance(parcel: Parcel, p: vec2f) -> f32 {
  let first = parcel.first;
  let n = parcel.points;
  var d = dot(p - outlines[first], p - outlines[first]);
  var s = 1.0;
  var j = n - 1u;
  for (var i = 0u; i < n; i++) {
    let vi = outlines[first + i];
    let vj = outlines[first + j];
    let e = vj - vi;
    let w = p - vi;
    let b = w - e * saturate(dot(w, e) / max(dot(e, e), 1e-9));
    d = min(d, dot(b, b));
    let above = p.y >= vi.y;
    let below = vj.y > p.y;
    let turns = e.x * w.y > e.y * w.x;
    if ((above && below && turns) || (!above && !below && !turns)) {
      s = -s;
    }
    j = i;
  }
  return s * sqrt(d);
}

fn boxLine(p: vec2f, middle: vec2f, half: vec2f, line: f32, w: f32) -> f32 {
  let q = p - middle;
  let outer = band(q.x, -half.x, half.x, w) * band(q.y, -half.y, half.y, w);
  let inner = band(q.x, -half.x + line, half.x - line, w) * band(q.y, -half.y + line, half.y - line, w);
  return saturate(outer - inner);
}

fn ringLine(p: vec2f, radius: f32, line: f32, w: f32) -> f32 {
  return band(length(p), radius - 0.5 * line, radius + 0.5 * line, w);
}

fn longways(p: vec2f, half: vec2f) -> vec3f {
  if (half.x >= half.y) {
    return vec3f(p, 0.0);
  }
  return vec3f(p.y, -p.x, 1.0);
}

fn pitchOf(p: vec2f, half: vec2f, xz: vec2f, w: f32) -> vec3f {
  let q = longways(p, half);
  let l = select(half, half.yx, q.z > 0.5);
  let field = l - vec2f(PITCH_INSET);
  let mown = stripes(q.x + field.x, 2.0 * field.x / 10.0, field.x / 10.0, w);
  let wear = planarNoise(xz * 0.8, 1u, LAWN_SALT) * 0.06;
  var c = LAWN * (0.94 + 0.1 * mown + wear);
  var lines = boxLine(q.xy, vec2f(0.0), field, MARK_LINE, w);
  lines = max(lines, band(q.x, -0.5 * MARK_LINE, 0.5 * MARK_LINE, w) * band(q.y, -field.y, field.y, w));
  lines = max(lines, ringLine(q.xy, 0.27 * field.y, MARK_LINE, w));
  let box = vec2f(0.157 * field.x, 0.59 * field.y);
  let goal = vec2f(0.052 * field.x, 0.27 * field.y);
  for (var e = -1.0; e <= 1.0; e += 2.0) {
    lines = max(lines, boxLine(q.xy, vec2f(e * (field.x - box.x), 0.0), box, MARK_LINE, w));
    lines = max(lines, boxLine(q.xy, vec2f(e * (field.x - goal.x), 0.0), goal, MARK_LINE, w));
  }
  return mix(c, LINE_WHITE * 0.9, lines);
}

fn trackOf(p: vec2f, half: vec2f, xz: vec2f, w: f32) -> vec3f {
  let q = longways(p, half);
  let l = select(half, half.yx, q.z > 0.5);
  let radius = l.y - 0.1;
  let straight = max(l.x - 0.1 - radius, 0.0);
  let r = length(vec2f(max(abs(q.x) - straight, 0.0), q.y));
  let lanes = clamp(floor(0.35 * radius / TRACK_LANE), 2.0, 6.0);
  let inner = radius - lanes * TRACK_LANE;
  let onTrack = band(r, inner, radius, w);
  let laneLines = joints(r - inner, TRACK_LANE, MARK_LINE * 0.7, w) * band(r, inner - 0.02, radius + 0.02, w);
  let infield = LAWN * (0.95 + planarNoise(xz * 0.8, 1u, LAWN_SALT) * 0.06);
  let outside = mix(infield, GRAVEL, step(radius, r));
  let track = mix(TRACK_RED * (1.0 + planarNoise(xz * 2.0, 1u, GRAVEL_SALT) * 0.05), LINE_WHITE * 0.85, laneLines);
  return mix(outside, track, onTrack);
}

fn plazaOf(p: vec2f, xz: vec2f, d: f32, w: f32) -> vec3f {
  let row = floor(p.y / 0.125);
  let shift = 0.125 * (row - 2.0 * floor(row * 0.5));
  let q = vec2f(p.x + shift, p.y);
  let stone = vec2i(i32(floor(q.x / 0.25)), i32(row));
  let tint = 0.9 + 0.18 * planarHash(stone, 1u, PAVING_SALT);
  let jointed = max(joints(q.x, 0.25, 0.012, w), joints(q.y, 0.125, 0.012, w)) * detail(0.12, w);
  var c = PAVING * tint * (1.0 - 0.35 * jointed);
  let border = band(-d, 0.0, 0.12, w);
  c = mix(c, PAVING_BORDER * (1.0 + planarNoise(xz * 6.0, 1u, GRAVEL_SALT) * 0.08), border);
  return c;
}

fn fieldOf(parcel: Parcel, p: vec2f, xz: vec2f, d: f32, w: f32) -> vec3f {
  let seed = parcel.id;
  let paddy = planarHash(vec2i(i32(seed), 0), 1u, CROP_SALT) < 0.4;
  let plot = floor((p.x + parcel.half.x) / 3.0);
  let growth = planarHash(vec2i(i32(plot), i32(seed) + 1), 1u, CROP_SALT);
  let rows = stripes(p.y, 0.25, 0.13, w);
  let tuft = planarNoise(xz * vec2f(6.0, 1.5), 1u, CROP_SALT) * 0.12 * detail(0.2, w);
  var c: vec3f;
  if (paddy) {
    c = PADDY * (0.9 + 0.15 * growth) * (1.0 - 0.08 * stripes(p.y, 0.1, 0.05, w) + tuft);
  } else {
    let green = CROP * mix(0.7, 1.15, growth) * (1.0 + tuft);
    c = mix(BARE_EARTH * 1.15, green, mix(rows, 1.0, 0.55 * growth));
  }
  let ridge = max(band(-d, 0.0, 0.15, w), joints(p.x + parcel.half.x, 3.0, 0.08, w));
  return mix(c, BARE_EARTH * 1.2 * (1.0 + planarNoise(xz * 3.0, 1u, SOIL_SALT) * 0.1), ridge * 0.8);
}

fn gardenOf(parcel: Parcel, p: vec2f, xz: vec2f, w: f32) -> vec3f {
  let clods = planarNoise(xz * 7.0, 1u, SOIL_SALT) * 0.15 * detail(0.12, w);
  var c = SOIL * (1.0 + clods - 0.2 * stripes(p.y, 0.15, 0.05, w));
  let x = p.x + parcel.half.x;
  let bed = floor(x / 1.0);
  let growth = planarHash(vec2i(i32(bed), i32(parcel.id)), 1u, SOIL_SALT);
  let rows = stripes(p.y + 0.04, 0.15, mix(0.04, 0.1, growth), w) * step(0.3, growth);
  c = mix(c, CROP * mix(0.55, 0.95, growth), rows);
  let path = joints(x, 1.0, 0.1, w);
  return mix(c, BARE_EARTH * 1.25, path);
}

fn shrineOf(p: vec2f, half: vec2f, xz: vec2f, w: f32) -> vec3f {
  let raked = stripes(p.x, 0.06, 0.03, w);
  var c = gravelOf(SHRINE_GRAVEL, xz, w) * (1.0 - 0.06 * raked);
  let path = band(p.x, -0.2, 0.2, w) * band(p.y, -0.3 * half.y, half.y + 1.0, w);
  let slabs = joints(p.y, 0.25, 0.015, w) * detail(0.12, w);
  return mix(c, PAVING * 1.1 * (1.0 - 0.4 * slabs), path);
}

fn parkingOf(p: vec2f, half: vec2f, xz: vec2f, w: f32) -> vec3f {
  var c = asphaltOf(xz, w) * 1.15;
  let back = -half.y + 0.05;
  let rows = select(1.0, 2.0, 2.0 * half.y > 2.0 * BAY_LENGTH + 1.4);
  var lines = 0.0;
  for (var r = 0.0; r < rows; r += 1.0) {
    let low = select(back, half.y - 0.05 - BAY_LENGTH, r > 0.5);
    let inRow = band(p.y, low, low + BAY_LENGTH, w);
    let dividers = joints(p.x + half.x - 0.1, BAY_WIDTH, BAY_LINE, w) * band(p.x, -half.x + 0.05, half.x - 0.05, w);
    let end = band(p.y, select(low + BAY_LENGTH - BAY_LINE, low, r > 0.5), select(low + BAY_LENGTH, low + BAY_LINE, r > 0.5), w) * band(p.x, -half.x + 0.1, half.x - 0.1, w);
    lines = max(lines, max(dividers * inRow, end));
  }
  return mix(c, LINE_WHITE * 0.85, lines);
}

fn lotOf(parcel: Parcel, p: vec2f, xz: vec2f, w: f32) -> vec3f {
  let roll = planarHash(vec2i(i32(parcel.id), 7), 1u, LOT_SALT);
  let half = parcel.half;
  var c = gravelOf(GRAVEL, xz, w);
  if (roll > 0.65) {
    let moss = saturate(0.25 + 0.3 * planarNoise(xz * 1.5, 1u, LAWN_SALT));
    c = mix(BARE_EARTH * 1.35, LAWN * 0.8, moss) * (1.0 + planarNoise(xz * 9.0, 1u, GRAIN_SALT) * 0.08 * detail(0.1, w));
  }
  let left = select(1.0, -1.0, fract(roll * 7.0) > 0.5);
  let depth = min(1.3, 1.2 * half.y);
  let width = min(0.75, half.x);
  let carX = left * (half.x - 0.5 * width - 0.05);
  let pad = band(p.x, carX - 0.5 * width, carX + 0.5 * width, w) * band(p.y, half.y - depth, half.y + 1.0, w);
  let crack = joints(p.y - half.y, 0.6, 0.01, w) * detail(0.1, w);
  c = mix(c, CONCRETE * (1.0 + planarNoise(xz * 3.0, 1u, PAVING_SALT) * 0.05) * (1.0 - 0.3 * crack), pad);
  return c;
}

@fragment
fn fs_pad(in: PadOut) -> @location(0) vec4f {
  let parcel = parcelAt(in.parcel);
  let p = in.local;
  let xz = in.world.xz;
  let d = outlineDistance(parcel, p);
  let w = max(length(fwidth(p)), 1e-5);
  let wd = max(fwidth(d), 1e-5);
  let kind = parcel.kind;
  var c: vec3f;
  var soft = wd;
  var rim = 0.0;
  if (kind == LOT) {
    c = lotOf(parcel, p, xz, w);
    rim = 0.5;
  } else if (kind == PLAZA) {
    c = plazaOf(p, xz, d, w);
    rim = 1.0;
  } else if (kind == PITCH) {
    c = pitchOf(p, parcel.half, xz, w);
    soft = max(wd, 0.05);
  } else if (kind == PLAYGROUND) {
    let edge = band(-d, 0.0, 0.15, w);
    c = mix(SAND * (1.0 + planarNoise(xz * 9.0, 1u, SAND_SALT) * 0.08 * detail(0.1, w)), RUBBER, edge);
    rim = 0.6;
  } else if (kind == TRACK) {
    c = trackOf(p, parcel.half, xz, w);
    soft = max(wd, 0.05);
  } else if (kind == FIELD) {
    c = fieldOf(parcel, p, xz, d, w);
    soft = max(wd, 0.12);
  } else if (kind == GARDEN) {
    c = gardenOf(parcel, p, xz, w);
    soft = max(wd, 0.08);
  } else if (kind == SHRINE) {
    c = shrineOf(p, parcel.half, xz, w);
    rim = 0.6;
  } else {
    c = parkingOf(p, parcel.half, xz, w);
    rim = 1.0;
  }
  let cover = saturate(0.5 - d / soft);
  let t = saturate(d / SKIRT);
  let shoulder = SHOULDER_DARK * rim * (1.0 - t) * (1.0 - t) * step(0.0, d);
  let paint = over(Paint(EARTH, shoulder), c, cover);
  if (paint.cover <= 0.004) {
    discard;
  }
  return vec4f(lit(paint.color, xz), paint.cover);
}
