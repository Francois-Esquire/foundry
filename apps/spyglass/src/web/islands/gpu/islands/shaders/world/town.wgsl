// The structures on the islands' tops (town-draw.ts, structures-build.ts):
// buildings, parcel walls and hedges, poles, each a few parts, and each part
// one instance of a shape built from the vertex index with no vertex
// buffer. A box is four walls and a top; a roof is a slab over a footprint,
// gabled, hipped or a lean-to, with thick edges, the undersides of its
// eaves and, for a shrine, sagging slopes and upturned eaves; a round is a
// round wall under a cone; an open part is a box with a floor, cut by its
// style into a balcony's panels, an outside stair's flights, a net, a
// climbing frame or a fence. One draw a shape, the parts sorted into a run
// for each; the open parts discard, so they have a fragment entry of their
// own and the solid parts keep their early depth test.
//
// Shading follows Townscaper (REFERENCES.md): one flat colour a face, the
// colour chosen for each building on the CPU (structures-palette.ts), deep
// occlusion under the eaves and at the walls' feet, and only fine patterns
// (siding, boards, tile courses) that fade before they alias.
//
// Everything is built at one human scale (town-parts.ts): a door is
// DOOR_HEIGHT tall, a storey STOREY. A tall building is more storeys of the
// same windows, never a small one scaled up, so its windows count its
// floors.
//
// A part stands on its site (town-floors.wgsl): its heights are above the
// ground at the site's middle, and a wall that rises from the floor
// reaches down to the lowest ground under the site, so it never floats on
// a slope. The site's ground, occlusion and sun were found once, when the
// maps or the plan last changed; a body samples no texture. A second draw
// lays each casting part's shadow on the ground round it, a soft patch
// cast away from the sun and blended over the terrain: the light map,
// baked without the town, casts none for it. A third hangs the wires
// between the poles.
import { planarHash, planarNoise } from "../../../../shaders/noise/planar.wgsl";

struct Props {
  viewProjection: mat4x4f,
  // Toward the sun, world space.
  sun: vec3f,
  sunStrength: f32,
  sunColor: vec3f,
  skyStrength: f32,
  skyColor: vec3f,
  shadowStrength: f32,
  seaFill: vec3f,
  // The baked occlusion's power and the sun's share of it (terrain.wgsl).
  occlusion: f32,
  // The maps' square: its corner and side, chart units.
  origin: vec2f,
  side: f32,
  occlusionSun: f32,
  // The film's size, pixels: for the wires' width.
  viewport: vec2f,
}

// Five vec4f a part (town-parts.ts `packInto`): its middle, turn and
// variant; half its footprint, its base and wall; its site, its rise, its
// material and its trim; its doors, its flags, its style (an open part's)
// or its overhang (a roof's or a round's), and its places; its colour and
// its trim's colour, packed, and its windows' style.
struct Part {
  at: vec2f,
  turn: f32,
  variant: f32,
  half: vec2f,
  base: f32,
  wall: f32,
  site: u32,
  rise: f32,
  material: u32,
  trim: u32,
  doors: u32,
  flags: u32,
  style: f32,
  places: f32,
  color: f32,
  trimColor: f32,
  windowStyle: u32,
}

@group(0) @binding(0) var<uniform> props: Props;
@group(0) @binding(1) var<storage, read> parts: array<vec4f>;
// A vec4f a site (town-floors.wgsl): the ground at its middle, how far
// below that its floor sinks, its occlusion and its sun.
@group(0) @binding(2) var<storage, read> floors: array<vec4f>;
// r: the ground's height, for the shadows draped over it.
@group(0) @binding(3) var height: texture_2d<f32>;
@group(0) @binding(4) var linear: sampler;
// Three vec4f a wire (structures-poles.ts `packWires`): one end and its
// height over its pole's site, and that site; the other end the same; its
// sag and its radius.
@group(0) @binding(5) var<storage, read> wires: array<vec4f>;

// The human scale, chart units (town-parts.ts, the same names): about four
// metres a unit.
const DOOR_HEIGHT = 0.5;
const DOOR_WIDTH = 0.24;
const STOREY = 0.75;
// How near a wall's corner a window may come, and how wide a gap a window
// leaves round a door.
const WINDOW_CORNER = 0.2;
const WINDOW_DOOR_GAP = 0.3;
// A window's and a door's frame.
const FRAME = 0.018;
// A shop's glazing: from its sill to its head, its mullions' spacing.
const SHOP_SILL = 0.04;
const SHOP_HEAD = 0.6;
const MULLION_SPACING = 0.6;
// A flat roof's parapet: how wide its top is.
const PARAPET_RIM = 0.08;
// A balcony's or a corridor's panel over its floor, and its slab.
const PANEL = 0.3;
const SLAB = 0.05;
// An outside stair's stringer, a net's mesh and its cords, a frame's bars.
const STRINGER = 0.1;
const MESH = 0.1;
const CORD = 0.012;
const BAR = 0.035;
// A garden fence's posts and rails, and a tall fence's mesh.
const FENCE_POSTS = 0.42;
const FENCE_BAR = 0.022;
const FENCE_MESH = 0.06;
const TALL_FENCE = 0.5;
// A stand's seat rows.
const SEAT_ROW = 0.18;
// How far a round's eave hangs below its wall's top.
const EAVE_DROP = 0.06;
// The fine patterns, chart units: siding's laps, boards, corrugations,
// roof tile courses, standing seams, concrete blocks.
const LAP = 0.05;
const BOARD = 0.06;
const CORRUGATION = 0.03;
const TILE_COURSE = 0.075;
const SEAM_SPACING = 0.11;
// Half the width of a roof's ridge capping.
const RIDGE_CAP = 0.04;
const BLOCK_COURSE = 0.05;

// The shapes (town-parts.ts `TOWN_SHAPES`) and the faces of a part.
const BOX = 0u;
const ROOF = 1u;
const ROUND = 2u;
const OPEN = 3u;
const WALL = 0u;
const TOP = 1u;
const SLOPE = 2u;
const EAVE = 3u;
const GABLE = 4u;
const BOTTOM = 5u;
const FASCIA = 6u;

// The materials (town-parts.ts `TOWN_MATERIALS`).
const TIMBER = 3u;
const METAL = 4u;
const TILE = 5u;
const BLUE_TILE = 6u;
const GLASS = 8u;
const SIGN = 9u;
const HEDGE = 13u;
const SEATS = 15u;
const LAMP = 16u;
const BLOCK = 17u;
const SIDING = 20u;
const SEAM = 21u;
const CLOCK = 22u;
const VENDING = 23u;

// An open part's styles (town-parts.ts `OPEN_STYLES`).
const BALCONY = 0u;
const STAIR = 1u;
const NET_STYLE = 2u;
const FENCE_STYLE = 4u;

// The windows' styles (town-parts.ts `WINDOW_STYLES`).
const SLIDING = 1u;
const NARROW = 2u;
const RIBBON = 3u;
const SPARSE = 4u;

// The flags (town-parts.ts `flagsOf`), the shape packed above them, and
// the door row's count above the faces' bits.
const WINDOWS = 2u;
const HIPPED = 4u;
const PARAPET = 8u;
const SHOPFRONT = 16u;
const BANDED = 32u;
const ROW_EVERY = 64u;
const SHED = 128u;
const CURVED = 256u;
const EAVED = 512u;
const BAY = 1024u;
const SHAPE_SHIFT = 12u;
const ROW_SHIFT = 4u;
const NORTH = 4u;
const SOUTH = 8u;

// Slices round a round (town-draw.ts `TOWN_VERTICES.round`): fifteen vertices
// a slice, six of wall, three of cone and six of eave.
const SEGMENTS = 12u;
const TAU = 6.2831853;
const PI = 3.14159265;

// Salts 830–832: the roofs' tiles, the hedges' leaves and the seats'
// blocks (829, the walls' old grain, is no longer drawn). Salts 870–872:
// which windows are left blind, which are curtained, and the boards'
// shades.
const TILE_SALT = 830u;
const HEDGE_SALT = 831u;
const SEAT_SALT = 832u;
const WINDOW_SALT = 870u;
const CURTAIN_SALT = 871u;
const BOARD_SALT = 872u;

// Linear colours of what no building chooses: a doorway, a window's glass,
// a curtain behind it, its frame, a slip's dark water, concrete, steel, a
// net, a flat roof's membrane, the seats' second colour.
const DOOR_COLOR = vec3f(0.07, 0.055, 0.045);
const WINDOW_COLOR = vec3f(0.035, 0.045, 0.055);
const CURTAIN_COLOR = vec3f(0.42, 0.38, 0.3);
const FRAME_COLOR = vec3f(0.42, 0.43, 0.42);
const SLIP_COLOR = vec3f(0.012, 0.016, 0.02);
const CONCRETE_COLOR = vec3f(0.36, 0.35, 0.33);
const STEEL_COLOR = vec3f(0.08, 0.085, 0.09);
const NET_COLOR = vec3f(0.06, 0.09, 0.07);
const MEMBRANE_COLOR = vec3f(0.2, 0.2, 0.19);
const SEAT_OTHER = vec3f(0.5, 0.5, 0.48);
// What glows: a shop's lit glass, a sign's white and its stripes, a lamp,
// a vending machine's front.
const SHOP_GLOW = vec3f(0.9, 0.82, 0.62);
const SIGN_WHITE = vec3f(0.95, 0.95, 0.92);
const SIGN_GREEN = vec3f(0.05, 0.45, 0.2);
const SIGN_ORANGE = vec3f(0.85, 0.36, 0.06);
const SIGN_BLUE = vec3f(0.06, 0.22, 0.6);
const LAMP_GLOW = vec3f(1.0, 0.95, 0.82);
const VENDING_GLOW = vec3f(0.95, 0.9, 0.78);
const SHOP_STRENGTH = 0.6;
const SIGN_STRENGTH = 1.1;
const LAMP_STRENGTH = 3.0;
const VENDING_STRENGTH = 0.55;

// The light: how much the sky's fill is greyed on the buildings, the warm
// light thrown back up off sunlit ground onto walls and eaves, how dark
// it is right under the eaves and at a wall's foot.
const FILL_GREY = 0.6;
const GROUND_BOUNCE = vec3f(0.3, 0.26, 0.18);
const UNDER_EAVES = 0.35;
const EAVE_BAND = 0.32;
const EAVE_SHADE = 0.24;
const FOOT_DARK = 0.5;
const FOOT_HEIGHT = 0.35;
// How much of the sun a wall's foot keeps: the ground's own occlusion.
const FOOT_SUN = 0.6;

// Two triangles over a unit square, as its corners.
const QUAD = array<vec2u, 6>(vec2u(0u, 0u), vec2u(1u, 0u), vec2u(1u, 1u), vec2u(0u, 0u), vec2u(1u, 1u), vec2u(0u, 1u));

fn partAt(index: u32) -> Part {
  let a = parts[index * 5u];
  let b = parts[index * 5u + 1u];
  let c = parts[index * 5u + 2u];
  let d = parts[index * 5u + 3u];
  let e = parts[index * 5u + 4u];
  return Part(
    a.xy,
    a.z,
    a.w,
    b.xy,
    b.z,
    b.w,
    u32(c.x),
    c.y,
    u32(c.z),
    u32(c.w),
    u32(d.x),
    u32(d.y),
    d.z,
    d.w,
    e.x,
    e.y,
    u32(e.z),
  );
}

fn shapeOf(part: Part) -> u32 {
  return part.flags >> SHAPE_SHIFT;
}

fn has(part: Part, flag: u32) -> bool {
  return (part.flags & flag) != 0u;
}

// A colour packed as red × 65536 + green × 256 + blue (town-parts.ts
// `packColor`), standard RGB, made linear.
fn colorOf(packed: f32) -> vec3f {
  let v = u32(packed);
  let srgb = vec3f(f32((v >> 16u) & 255u), f32((v >> 8u) & 255u), f32(v & 255u)) / 255.0;
  let low = srgb / 12.92;
  let high = pow((srgb + 0.055) / 1.055, vec3f(2.4));
  return select(high, low, srgb <= vec3f(0.04045));
}

// A point on a part, in its own frame: y up from the ground at its site.
struct Corner {
  p: vec3f,
  normal: vec3f,
  face: u32,
  material: u32,
}

// Turns the part's frame into the chart's: its local z toward −x by its turn.
fn spinOf(turn: f32) -> mat2x2f {
  return mat2x2f(cos(turn), sin(turn), -sin(turn), cos(turn));
}

struct PartOut {
  @builtin(position) position: vec4f,
  @location(0) normal: vec3f,
  // The part's frame, y up from the ground at its site.
  @location(1) local: vec3f,
  @location(2) @interpolate(flat) localNormal: vec3f,
  // The shape, the face, the material, the doors.
  @location(3) @interpolate(flat) kind: vec4u,
  // Half the footprint, the wall's top, the variant.
  @location(4) @interpolate(flat) size: vec4f,
  // The site's occlusion and sun.
  @location(5) @interpolate(flat) light: vec4f,
  // The flags, the trim's material, the windows' style.
  @location(6) @interpolate(flat) flags: vec4u,
  // Its base, its style, its places, the lowest its walls reach.
  @location(7) @interpolate(flat) extra: vec4f,
  // The face's colour, and the trim's.
  @location(8) @interpolate(flat) color: vec3f,
  @location(9) @interpolate(flat) trimColor: vec3f,
}

fn emit(part: Part, shape: u32, c: Corner) -> PartOut {
  let site = floors[part.site];
  let spin = spinOf(part.turn);
  let xz = part.at + spin * c.p.xz;
  let world = vec3f(xz.x, site.x + c.p.y, xz.y);
  var out: PartOut;
  out.position = props.viewProjection * vec4f(world, 1.0);
  let n = spin * c.normal.xz;
  out.normal = vec3f(n.x, c.normal.y, n.y);
  out.local = c.p;
  out.localNormal = c.normal;
  out.kind = vec4u(shape, c.face, c.material, part.doors);
  out.size = vec4f(part.half, part.base + part.wall, part.variant);
  out.light = vec4f(site.z, site.w, 0.0, 0.0);
  out.flags = vec4u(part.flags, part.trim, part.windowStyle, 0u);
  out.extra = vec4f(part.base, part.style, part.places, lowOf(part));
  let main = colorOf(part.color);
  let trim = colorOf(part.trimColor);
  let isTrim = c.material == part.trim && part.trim != part.material;
  out.color = select(main, trim, isTrim);
  out.trimColor = trim;
  return out;
}

// The floor a part's walls reach down to: its base, or below the lowest
// ground under its site when it stands on the ground.
fn lowOf(part: Part) -> f32 {
  return select(part.base, -floors[part.site].y, part.base <= 0.0);
}

// A box's four walls and its top, thirty vertices; an open part's floor
// after them, six more.
fn boxCorner(part: Part, vertex: u32) -> Corner {
  let low = lowOf(part);
  let top = part.base + part.wall;
  let h = part.half;
  let face = vertex / 6u;
  let q = QUAD[vertex % 6u];
  let s = vec2f(q) * 2.0 - 1.0;
  let y = select(low, top, q.y == 1u);
  switch face {
    case 0u: {
      return Corner(vec3f(h.x, y, s.x * h.y), vec3f(1.0, 0.0, 0.0), WALL, part.material);
    }
    case 1u: {
      return Corner(vec3f(-h.x, y, s.x * h.y), vec3f(-1.0, 0.0, 0.0), WALL, part.material);
    }
    case 2u: {
      return Corner(vec3f(s.x * h.x, y, h.y), vec3f(0.0, 0.0, 1.0), WALL, part.material);
    }
    case 3u: {
      return Corner(vec3f(s.x * h.x, y, -h.y), vec3f(0.0, 0.0, -1.0), WALL, part.material);
    }
    case 4u: {
      return Corner(vec3f(s.x * h.x, top, s.y * h.y), vec3f(0.0, 1.0, 0.0), TOP, part.material);
    }
    default: {
      return Corner(vec3f(s.x * h.x, max(low, part.base), s.y * h.y), vec3f(0.0, -1.0, 0.0), BOTTOM, part.material);
    }
  }
}

@vertex
fn vs_box(@builtin(vertex_index) vertex: u32, @builtin(instance_index) index: u32) -> PartOut {
  let part = partAt(index);
  return emit(part, BOX, boxCorner(part, vertex));
}

@vertex
fn vs_open(@builtin(vertex_index) vertex: u32, @builtin(instance_index) index: u32) -> PartOut {
  let part = partAt(index);
  return emit(part, OPEN, boxCorner(part, vertex));
}

// A roof (town-draw.ts `ROOF_QUADS`): a slab of FASCIA_DEPTH over a
// footprint, its ridge along local z, built as a fixed list of quads, each
// six vertices, the ones a roof has no use for collapsed to a point. The
// slopes are cut into ROOF_STRIPS strips from each eave to the ridge, so a
// curved roof can sag; a gabled roof has gable walls under its ends, cut
// the same way, and the undersides and edges of its rakes; a hipped roof
// has a sloping triangle at each end instead. Every roof has the
// undersides of its eaves, from their edge in to the walls, and a fascia
// along every edge, so it reads as a thick lid from far away.
const ROOF_STRIPS = 4u;
const FASCIA_DEPTH = 0.035;
// How much a curved roof's slopes sag below straight, and its eaves turn up.
const SAG = 0.45;

struct RoofShape {
  hx: f32,
  hz: f32,
  base: f32,
  rise: f32,
  reachX: f32,
  reachZ: f32,
  // A hipped roof's ridge's half length.
  ridge: f32,
  sag: f32,
  hipped: bool,
  shed: bool,
}

fn roofShapeOf(part: Part) -> RoofShape {
  let hx = part.half.x;
  let hz = part.half.y;
  let overhang = part.style;
  let hipped = has(part, HIPPED) && !has(part, SHED);
  return RoofShape(
    hx,
    hz,
    part.base,
    part.rise,
    hx + overhang,
    hz + overhang,
    max(hz - hx, 0.0),
    select(0.0, SAG, has(part, CURVED)),
    hipped,
    has(part, SHED),
  );
}

// The height of the roof's top at local x: through the walls' tops at
// ±hx and the ridge at 0, or a lean-to's from +hx up to −hx; a curved
// roof bows below the straight line between and lifts past the walls.
fn roofY(r: RoofShape, x: f32) -> f32 {
  var u = (r.hx - abs(x)) / r.hx;
  if (r.shed) {
    u = (r.hx - x) / (2.0 * r.hx);
  }
  return r.base + r.rise * (u - r.sag * u * (1.0 - u));
}

// Where across the roof strip j starts and ends: from the +x eave in to
// the ridge, then from the −x eave in; a lean-to's one slope from +x to −x.
fn stripOf(r: RoofShape, j: u32) -> vec2f {
  let step = r.reachX / f32(ROOF_STRIPS);
  if (r.shed) {
    return vec2f(r.reachX - f32(j) * step, r.reachX - f32(j + 1u) * step);
  }
  let side = select(-1.0, 1.0, j < ROOF_STRIPS);
  let k = f32(j % ROOF_STRIPS);
  return side * vec2f(r.reachX - k * step, r.reachX - (k + 1.0) * step);
}

// How far along the ridge a slope reaches at x: to the gable ends' rakes,
// or in along a hip to the ridge's end.
fn reachAt(r: RoofShape, x: f32) -> f32 {
  if (r.hipped) {
    return r.ridge + (r.reachZ - r.ridge) * abs(x) / r.reachX;
  }
  return r.reachZ;
}

struct RoofQuad {
  corners: array<vec3f, 4>,
  face: u32,
  // Which way the face looks, to orient its normal.
  out: vec3f,
}

fn collapsed() -> RoofQuad {
  return RoofQuad(array<vec3f, 4>(vec3f(0.0), vec3f(0.0), vec3f(0.0), vec3f(0.0)), SLOPE, vec3f(0.0, 1.0, 0.0));
}

fn roofQuad(r: RoofShape, q: u32) -> RoofQuad {
  let strips = ROOF_STRIPS;
  let depth = FASCIA_DEPTH;
  // The slopes' strips.
  if (q < 2u * strips) {
    let x = stripOf(r, q);
    let a = roofY(r, x.x);
    let b = roofY(r, x.y);
    let za = reachAt(r, x.x);
    let zb = reachAt(r, x.y);
    return RoofQuad(array<vec3f, 4>(vec3f(x.x, a, -za), vec3f(x.x, a, za), vec3f(x.y, b, zb), vec3f(x.y, b, -zb)), SLOPE, vec3f(0.0, 1.0, 0.0));
  }
  // The ends: a hipped roof's sloping triangles, or the gable walls in strips.
  if (q < 6u * strips) {
    let k = q - 2u * strips;
    let end = select(-1.0, 1.0, k < 2u * strips);
    let j = k % (2u * strips);
    if (r.hipped) {
      if (j != 0u) {
        return collapsed();
      }
      let eave = roofY(r, r.reachX);
      let top = r.base + r.rise;
      let apex = vec3f(0.0, top, end * r.ridge);
      return RoofQuad(array<vec3f, 4>(vec3f(-r.reachX, eave, end * r.reachZ), vec3f(r.reachX, eave, end * r.reachZ), apex, apex), SLOPE, vec3f(0.0, 1.0, end));
    }
    let x = clamp(stripOf(r, j), vec2f(-r.hx), vec2f(r.hx));
    let z = end * r.hz;
    return RoofQuad(array<vec3f, 4>(vec3f(x.x, r.base, z), vec3f(x.y, r.base, z), vec3f(x.y, roofY(r, x.y), z), vec3f(x.x, roofY(r, x.x), z)), GABLE, vec3f(0.0, 0.0, end));
  }
  // The eaves' undersides along the sides, and a hipped roof's along its ends.
  if (q < 6u * strips + 4u) {
    let k = q - 6u * strips;
    let side = select(-1.0, 1.0, (k % 2u) == 0u);
    if (k < 2u) {
      let outer = side * r.reachX;
      let inner = side * r.hx;
      let yo = roofY(r, outer) - depth;
      let yi = roofY(r, inner) - depth;
      let zi = select(r.reachZ, r.hz, r.hipped);
      return RoofQuad(array<vec3f, 4>(vec3f(outer, yo, -r.reachZ), vec3f(outer, yo, r.reachZ), vec3f(inner, yi, zi), vec3f(inner, yi, -zi)), EAVE, vec3f(0.0, -1.0, 0.0));
    }
    if (!r.hipped) {
      return collapsed();
    }
    let yo = roofY(r, r.reachX) - depth;
    let yi = r.base - depth;
    return RoofQuad(array<vec3f, 4>(vec3f(-r.reachX, yo, side * r.reachZ), vec3f(r.reachX, yo, side * r.reachZ), vec3f(r.hx, yi, side * r.hz), vec3f(-r.hx, yi, side * r.hz)), EAVE, vec3f(0.0, -1.0, 0.0));
  }
  // The undersides of a gabled roof's rakes, past its gable walls.
  if (q < 10u * strips + 4u) {
    if (r.hipped) {
      return collapsed();
    }
    let k = q - (6u * strips + 4u);
    let end = select(-1.0, 1.0, k < 2u * strips);
    let x = stripOf(r, k % (2u * strips));
    let a = roofY(r, x.x) - depth;
    let b = roofY(r, x.y) - depth;
    return RoofQuad(array<vec3f, 4>(vec3f(x.x, a, end * r.hz), vec3f(x.y, b, end * r.hz), vec3f(x.y, b, end * r.reachZ), vec3f(x.x, a, end * r.reachZ)), EAVE, vec3f(0.0, -1.0, 0.0));
  }
  // The fascia along the eaves: the sides, and a hipped roof's ends.
  if (q < 10u * strips + 8u) {
    let k = q - (10u * strips + 4u);
    let side = select(-1.0, 1.0, (k % 2u) == 0u);
    if (k < 2u) {
      let x = side * r.reachX;
      let y = roofY(r, x);
      return RoofQuad(array<vec3f, 4>(vec3f(x, y, -r.reachZ), vec3f(x, y, r.reachZ), vec3f(x, y - depth, r.reachZ), vec3f(x, y - depth, -r.reachZ)), FASCIA, vec3f(side, 0.0, 0.0));
    }
    if (!r.hipped) {
      return collapsed();
    }
    let y = roofY(r, r.reachX);
    let z = side * r.reachZ;
    return RoofQuad(array<vec3f, 4>(vec3f(-r.reachX, y, z), vec3f(r.reachX, y, z), vec3f(r.reachX, y - depth, z), vec3f(-r.reachX, y - depth, z)), FASCIA, vec3f(0.0, 0.0, side));
  }
  // The fascia up a gabled roof's rakes.
  if (r.hipped) {
    return collapsed();
  }
  let k = q - (10u * strips + 8u);
  let end = select(-1.0, 1.0, k < 2u * strips);
  let x = stripOf(r, k % (2u * strips));
  let a = roofY(r, x.x);
  let b = roofY(r, x.y);
  let z = end * r.reachZ;
  return RoofQuad(array<vec3f, 4>(vec3f(x.x, a, z), vec3f(x.y, b, z), vec3f(x.y, b - depth, z), vec3f(x.x, a - depth, z)), FASCIA, vec3f(0.0, 0.0, end));
}

@vertex
fn vs_roof(@builtin(vertex_index) vertex: u32, @builtin(instance_index) index: u32) -> PartOut {
  let part = partAt(index);
  let r = roofShapeOf(part);
  let quad = roofQuad(r, vertex / 6u);
  let q = QUAD[vertex % 6u];
  // The unit square's corner as the quad's: (0,0), (1,0), (1,1), (0,1).
  let corner = q.x + q.y * 3u - 2u * q.x * q.y;
  let c = quad.corners;
  // Both triangles' normals summed, so a quad folded to a triangle still has one.
  var n = cross(c[1] - c[0], c[2] - c[0]) + cross(c[2] - c[0], c[3] - c[0]);
  if (dot(n, quad.out) < 0.0) {
    n = -n;
  }
  n = select(quad.out, normalize(n), length(n) > 1e-8);
  let material = select(part.material, part.trim, quad.face == GABLE);
  return emit(part, ROOF, Corner(c[corner], n, quad.face, material));
}

fn ring(a: f32, r: f32, y: f32) -> vec3f {
  return vec3f(sin(a) * r, y, cos(a) * r);
}

// A round: SEGMENTS slices, each a quad of wall from its base (or the
// floor) to its top in its material, a triangle of cone up to the apex
// and a quad of eave under the cone's overhang, both in its trim. Angle 0
// faces +z, where a round's door is.
@vertex
fn vs_round(@builtin(vertex_index) vertex: u32, @builtin(instance_index) index: u32) -> PartOut {
  let part = partAt(index);
  let r = part.half.x;
  let slice = vertex / 15u;
  let v = vertex % 15u;
  let a0 = f32(slice) / f32(SEGMENTS) * TAU;
  let a1 = f32(slice + 1u) / f32(SEGMENTS) * TAU;
  let top = part.base + part.wall;
  let overhang = part.style;
  let eave = top - select(0.0, EAVE_DROP, overhang > 0.0);
  let reach = r + overhang;
  let apex = top + part.rise;
  if (v < 6u) {
    let q = QUAD[v];
    let a = select(a0, a1, q.x == 1u);
    let y = select(lowOf(part), top, q.y == 1u);
    return emit(part, ROUND, Corner(ring(a, r, y), vec3f(sin(a), 0.0, cos(a)), WALL, part.material));
  }
  if (v < 9u) {
    // The cone, its normal smooth round it.
    let k = v - 6u;
    let rise = max(apex - eave, 1e-3);
    if (k == 2u) {
      let mid = 0.5 * (a0 + a1);
      return emit(part, ROUND, Corner(vec3f(0.0, apex, 0.0), normalize(vec3f(sin(mid) * rise, reach, cos(mid) * rise)), SLOPE, part.trim));
    }
    let a = select(a0, a1, k == 1u);
    return emit(part, ROUND, Corner(ring(a, reach, eave), normalize(vec3f(sin(a) * rise, reach, cos(a) * rise)), SLOPE, part.trim));
  }
  let q = QUAD[v - 9u];
  let a = select(a0, a1, q.x == 1u);
  let p = select(ring(a, r, top), ring(a, reach, eave), q.y == 0u);
  return emit(part, ROUND, Corner(p, vec3f(0.0, -1.0, 0.0), EAVE, part.trim));
}

// Where on its wall a fragment lies: along the wall from the middle of
// its face, half the face's length, and which face it is.
struct Facing {
  along: f32,
  span: f32,
  face: u32,
}

fn facingOf(in: PartOut) -> Facing {
  if (in.kind.x == ROUND) {
    let r = in.size.x;
    let angle = atan2(in.local.x, in.local.z);
    return Facing(angle * r, PI * r, select(0u, NORTH, abs(angle) < 0.5));
  }
  let n = in.localNormal;
  if (abs(n.x) > abs(n.z)) {
    return Facing(in.local.z, in.size.y, select(2u, 1u, n.x > 0.0));
  }
  return Facing(in.local.x, in.size.x, select(SOUTH, NORTH, n.z > 0.0));
}

// How far along its face a fragment lies from the nearest door on its
// storey, or a long way when there is none.
fn doorGap(in: PartOut, f: Facing, storey: f32) -> f32 {
  let doors = in.kind.w;
  var gap = 1e3;
  if ((doors & f.face) != 0u && storey == 0.0) {
    gap = abs(f.along);
  }
  let row = doors >> ROW_SHIFT;
  let every = (in.flags.x & ROW_EVERY) != 0u;
  if (row > 0u && f.face == NORTH && (storey == 0.0 || every)) {
    let pitch = 2.0 * f.span / f32(row);
    let slot = (f.along + f.span) / pitch;
    let k = clamp(floor(slot), 0.0, f32(row) - 1.0);
    gap = min(gap, abs((slot - k - 0.5) * pitch));
  }
  return gap;
}

// A window style's cut: its width, sill and height, the spacing of its
// columns, and the share of them left blind.
struct WindowCut {
  width: f32,
  sill: f32,
  height: f32,
  spacing: f32,
  blind: f32,
}

fn windowCutOf(style: u32, ground: bool, front: bool) -> WindowCut {
  if (style == SLIDING) {
    // On the ground storey's front, glass doors down to the floor.
    if (ground && front) {
      return WindowCut(0.42, 0.03, 0.48, 0.85, 0.25);
    }
    return WindowCut(0.42, 0.22, 0.3, 0.85, 0.3);
  }
  if (style == NARROW) {
    return WindowCut(0.15, 0.2, 0.36, 0.5, 0.35);
  }
  if (style == RIBBON) {
    return WindowCut(1e3, 0.24, 0.32, 1.0, 0.0);
  }
  if (style == SPARSE) {
    return WindowCut(0.2, 0.3, 0.2, 0.9, 0.6);
  }
  return WindowCut(0.26, 0.24, 0.3, 0.72, 0.3);
}

// What a wall's fragment is: 0 the wall, 1 a doorway, 2 a window's glass,
// 3 a shop's lit glass, 4 a window's frame, 5 a curtained window, 6 a
// slip's dark mouth.
struct Opening {
  kind: u32,
  // The share of the wall that is window round here, for far away.
  share: f32,
}

fn openingOf(in: PartOut) -> Opening {
  let f = facingOf(in);
  let base = max(in.extra.x, 0.0);
  let y = in.local.y - base;
  // A boathouse's slip: open from below the ground up to under its first floor.
  let slip = (in.flags.x & BAY) != 0u && f.face == NORTH && abs(f.along) < f.span - 0.06;
  if (slip && y < STOREY - 0.1) {
    return Opening(6u, 0.0);
  }
  if (y < 0.0) {
    return Opening(0u, 0.0);
  }
  let storey = floor(y / STOREY);
  let up = y - storey * STOREY;
  let gap = doorGap(in, f, storey);
  if (gap < DOOR_WIDTH * 0.5 && up < DOOR_HEIGHT) {
    let frame = gap > DOOR_WIDTH * 0.5 - FRAME || up > DOOR_HEIGHT - FRAME;
    return Opening(select(1u, 4u, frame), 0.0);
  }
  let inside = abs(f.along) < f.span - WINDOW_CORNER * 0.5;
  if ((in.flags.x & SHOPFRONT) != 0u && f.face == NORTH && storey == 0.0) {
    let mullion = abs(fract(f.along / MULLION_SPACING + 0.5) - 0.5) * MULLION_SPACING < 0.015;
    if (inside && up > SHOP_SILL && up < SHOP_HEAD && !mullion) {
      return Opening(3u, 0.0);
    }
  }
  if ((in.flags.x & WINDOWS) == 0u) {
    return Opening(0u, 0.0);
  }
  let style = in.flags.z;
  let cut = windowCutOf(style, storey == 0.0, f.face == NORTH);
  let wallTop = in.size.z - base;
  let fits = storey * STOREY + cut.sill + cut.height < wallTop - 0.08;
  let share = select(0.0, (1.0 - cut.blind) * min(cut.width / cut.spacing, 1.0) * cut.height / STOREY, fits);
  let inBand = up > cut.sill && up < cut.sill + cut.height;
  let clear = abs(f.along) < f.span - WINDOW_CORNER && gap > WINDOW_DOOR_GAP;
  if (!(fits && inBand && clear)) {
    return Opening(0u, share);
  }
  var across = 0.0;
  var column = 0.0;
  if (style == RIBBON) {
    // A continuous band, its mullions every so often.
    let mullion = abs(fract(f.along / 0.3 + 0.5) - 0.5) * 0.3;
    if (mullion < FRAME * 0.6) {
      return Opening(4u, share);
    }
    column = floor(f.along / 0.3);
  } else {
    column = floor(f.along / cut.spacing + 0.5);
    across = abs(f.along - column * cut.spacing);
    if (across > cut.width * 0.5) {
      return Opening(0u, share);
    }
  }
  // Some columns on some storeys left blind, so a wall's windows are not a grid.
  let seed = u32(in.size.w * 65521.0) + f.face * 7u;
  let cell = vec2i(i32(column), i32(storey));
  if (planarHash(cell, seed, WINDOW_SALT) < cut.blind) {
    return Opening(0u, share);
  }
  let rim = min(cut.width * 0.5 - across, min(up - cut.sill, cut.sill + cut.height - up));
  let sash = style != RIBBON && abs(f.along - column * cut.spacing) < FRAME * 0.4 && cut.width > 0.3;
  if (rim < FRAME || sash) {
    return Opening(4u, share);
  }
  let curtained = planarHash(cell, seed, CURTAIN_SALT) < 0.3;
  return Opening(select(2u, 5u, curtained), share);
}

// A fine line pattern: 1 on a line of `width` (a share of `period`) every
// `period` along `t`, faded out before its lines are finer than a pixel
// (`pixel`, chart units a pixel).
fn lines(t: f32, period: f32, width: f32, pixel: f32) -> f32 {
  let d = abs(fract(t / period + 0.5) - 0.5);
  let line = 1.0 - smoothstep(width * 0.5, width * 0.5 + pixel / period, d);
  return line * (1.0 - smoothstep(0.2, 0.45, pixel / period));
}

// A material's own colour where a fragment lies on it, before its light:
// its colour, patterned.
fn materialAlbedo(material: u32, color: vec3f, along: f32, y: f32, seed: f32, pixel: f32) -> vec3f {
  if (material == SIDING) {
    return color * (1.0 - 0.07 * lines(y, LAP, 0.12, pixel));
  }
  if (material == TIMBER) {
    // Upright boards, each its own shade, their joints dark.
    let board = floor(along / BOARD);
    let shade = planarHash(vec2i(i32(board), 0), u32(seed * 4093.0), BOARD_SALT);
    let fade = 1.0 - smoothstep(0.2, 0.45, pixel / BOARD);
    return color * (1.0 + 0.1 * (shade - 0.5) * fade) * (1.0 - 0.25 * lines(along, BOARD, 0.08, pixel));
  }
  if (material == METAL) {
    // Corrugations, upright.
    let fade = 1.0 - smoothstep(0.15, 0.4, pixel / CORRUGATION);
    return color * (1.0 - 0.07 * fade * (0.5 + 0.5 * sin(along / CORRUGATION * TAU)));
  }
  if (material == BLOCK) {
    let course = floor(y / BLOCK_COURSE);
    let joint = max(lines(y, BLOCK_COURSE, 0.1, pixel), lines(along + 0.05 * course, 0.1, 0.05, pixel));
    return color * (1.0 - 0.18 * joint);
  }
  if (material == HEDGE) {
    let leaves = planarNoise(vec2f(along, y) * 14.0, 1u, HEDGE_SALT);
    return color * (1.0 + 0.3 * leaves * (1.0 - smoothstep(0.02, 0.06, pixel)));
  }
  if (material == GLASS) {
    return WINDOW_COLOR;
  }
  return color;
}

fn roofAlbedo(in: PartOut, pixel: f32) -> vec3f {
  let material = in.kind.z;
  // The ridge's capping tiles, darker, along the top of a two-sided roof.
  let capped = (in.flags.x & SHED) == 0u && in.kind.x == ROOF && abs(in.localNormal.z) < 0.05 && abs(in.local.x) < RIDGE_CAP;
  let color = in.color * select(1.0, 0.72, capped);
  if (material == TILE || material == BLUE_TILE) {
    // Courses of tile, each course's lower edge a dark line, faintly speckled.
    let course = lines(in.local.y + 0.5 * TILE_COURSE, TILE_COURSE, 0.18, pixel);
    let speck = planarNoise(in.local.xz * 9.0 + vec2f(0.0, floor(in.local.y / TILE_COURSE) * 3.1), 1u, TILE_SALT);
    let fade = 1.0 - smoothstep(0.01, 0.03, pixel);
    return color * (1.0 - 0.16 * course) * (1.0 + 0.05 * speck * fade);
  }
  if (material == SEAM) {
    // Standing seams down the slope, across the ridge's run.
    return color * (1.0 + 0.1 * lines(in.local.z, SEAM_SPACING, 0.1, pixel));
  }
  return materialAlbedo(material, color, in.local.x, in.local.y, in.size.w, pixel);
}

// A flat top: a parapet's rim round a membrane, a stand's seats in rows
// and blocks, or the material itself.
fn topAlbedo(in: PartOut, pixel: f32) -> vec3f {
  let p = in.local.xz;
  let half = in.size.xy;
  let material = in.kind.z;
  if (material == SEATS) {
    let places = max(in.extra.z, 1.0);
    let block = floor((p.x + half.x) / (2.0 * half.x) * places);
    let shade = 1.0 + 0.06 * planarNoise(vec2f(block, 0.5), 1u, SEAT_SALT);
    let color = select(in.color, SEAT_OTHER, (u32(block) % 2u) == 1u) * shade;
    let row = lines(p.y, SEAT_ROW, 0.25, pixel);
    return mix(color, CONCRETE_COLOR * 0.7, row);
  }
  if ((in.flags.x & PARAPET) != 0u) {
    let edge = min(half.x - abs(p.x), half.y - abs(p.y));
    if (edge > PARAPET_RIM) {
      // The membrane, darker close under the parapet.
      return MEMBRANE_COLOR * mix(0.7, 1.0, smoothstep(PARAPET_RIM, PARAPET_RIM + 0.15, edge));
    }
  }
  if (material == HEDGE) {
    // A clipped top, a little lighter where the new growth catches the sun.
    let leaves = planarNoise(p * 14.0, 1u, HEDGE_SALT);
    return in.color * 1.12 * (1.0 + 0.3 * leaves * (1.0 - smoothstep(0.02, 0.06, pixel)));
  }
  return materialAlbedo(material, in.color, p.x, p.y, in.size.w, pixel) * 0.94;
}

// A sign's face: a white band between two stripes in its chain's colours.
fn signGlow(in: PartOut) -> vec3f {
  let base = max(in.extra.x, 0.0);
  let t = (in.local.y - base) / max(in.size.z - base, 1e-3);
  let pick = u32(in.size.w * 3.0);
  var low = SIGN_GREEN;
  var high = SIGN_ORANGE;
  if (pick == 1u) {
    low = SIGN_BLUE;
    high = SIGN_WHITE;
  } else if (pick == 2u) {
    low = SIGN_ORANGE;
    high = SIGN_GREEN;
  }
  let stripe = select(SIGN_WHITE, low, t < 0.3);
  return select(stripe, high, t > 0.7);
}

struct Surface {
  albedo: vec3f,
  glow: vec3f,
  // How much of the light reaches it: 1 in the open, less under eaves.
  reach: f32,
}

// A vending machine's front: a lit display of its rows of drinks over a
// dark slot, its body in its colour round them.
fn vendingSurface(in: PartOut, f: Facing) -> Surface {
  let base = max(in.extra.x, 0.0);
  let t = (in.local.y - base) / max(in.size.z - base, 1e-3);
  let inside = abs(f.along) < f.span - 0.02;
  if (f.face == NORTH && inside && t > 0.38 && t < 0.9) {
    let row = lines(in.local.y, 0.055, 0.25, 0.0);
    return Surface(vec3f(0.3), VENDING_GLOW * VENDING_STRENGTH * (1.0 - 0.5 * row), 1.0);
  }
  if (f.face == NORTH && inside && t > 0.12 && t < 0.22) {
    return Surface(DOOR_COLOR, vec3f(0.0), 1.0);
  }
  return Surface(in.color, vec3f(0.0), 1.0);
}

// A clock's face: a white dial with a dark rim and two hands.
fn clockSurface(in: PartOut, f: Facing) -> Surface {
  if (f.face != NORTH) {
    return Surface(in.color * 0.6, vec3f(0.0), 1.0);
  }
  let base = max(in.extra.x, 0.0);
  let middle = vec2f(0.0, 0.5 * (base + in.size.z));
  let radius = min(f.span, 0.5 * (in.size.z - base)) * 0.92;
  let p = vec2f(f.along, in.local.y) - middle;
  let d = length(p);
  if (d > radius) {
    return Surface(vec3f(0.06), vec3f(0.0), 1.0);
  }
  // Ten past ten: the hour hand up and right, the minute hand up and left.
  let hour = normalize(vec2f(0.5, 0.35));
  let minute = normalize(vec2f(-0.55, 0.85));
  let onHour = abs(p.x * hour.y - p.y * hour.x) < radius * 0.06 && dot(p, hour) > 0.0 && d < radius * 0.55;
  let onMinute = abs(p.x * minute.y - p.y * minute.x) < radius * 0.04 && dot(p, minute) > 0.0 && d < radius * 0.8;
  let rim = d > radius * 0.86;
  if (onHour || onMinute || rim) {
    return Surface(vec3f(0.03), vec3f(0.0), 1.0);
  }
  return Surface(in.color, vec3f(0.0), 1.0);
}

fn wallSurface(in: PartOut, pixel: f32) -> Surface {
  let material = in.kind.z;
  let f = facingOf(in);
  if (material == SIGN) {
    let lit = abs(in.localNormal.z) > 0.5;
    return Surface(SIGN_WHITE * 0.3, select(SIGN_WHITE * 0.15, signGlow(in), lit) * SIGN_STRENGTH, 1.0);
  }
  if (material == LAMP) {
    return Surface(vec3f(0.3), LAMP_GLOW * LAMP_STRENGTH, 1.0);
  }
  if (material == VENDING) {
    return vendingSurface(in, f);
  }
  if (material == CLOCK) {
    return clockSurface(in, f);
  }
  let y = in.local.y;
  var wall = materialAlbedo(material, in.color, f.along, y, in.size.w, pixel);
  if ((in.flags.x & BANDED) != 0u) {
    let t = y / max(in.size.z, 1e-3);
    if (t > 0.55 && t < 0.68) {
      wall = in.trimColor;
    }
  }
  // Darker right under a roof's eaves, where the overhang hides the sky.
  var reach = 1.0;
  if ((in.flags.x & EAVED) != 0u) {
    reach = mix(UNDER_EAVES, 1.0, sqrt(smoothstep(0.0, EAVE_BAND, in.size.z - y)));
  }
  let opening = openingOf(in);
  // Far away a window is finer than a pixel: the wall takes its share of glass instead.
  let far = smoothstep(0.03, 0.07, pixel);
  let average = mix(wall, WINDOW_COLOR, opening.share * 0.85);
  switch opening.kind {
    case 1u: {
      return Surface(DOOR_COLOR, vec3f(0.0), reach);
    }
    case 2u: {
      // The sky faintly in the glass, brighter toward its top.
      let glass = WINDOW_COLOR + props.skyColor * 0.025 * props.skyStrength;
      return Surface(mix(glass, average, far), vec3f(0.0), reach);
    }
    case 3u: {
      return Surface(WINDOW_COLOR, SHOP_GLOW * SHOP_STRENGTH, 1.0);
    }
    case 4u: {
      return Surface(mix(FRAME_COLOR, average, far), vec3f(0.0), reach);
    }
    case 5u: {
      return Surface(mix(CURTAIN_COLOR * 0.45, average, far), vec3f(0.0), reach);
    }
    case 6u: {
      return Surface(SLIP_COLOR, vec3f(0.0), 1.0);
    }
    default: {
      return Surface(mix(wall, average, far), vec3f(0.0), reach);
    }
  }
}

fn surfaceOf(in: PartOut, pixel: f32) -> Surface {
  let face = in.kind.y;
  if (face == SLOPE) {
    if (in.kind.z == LAMP) {
      return Surface(vec3f(0.3), LAMP_GLOW * LAMP_STRENGTH, 1.0);
    }
    return Surface(roofAlbedo(in, pixel), vec3f(0.0), 1.0);
  }
  if (face == FASCIA) {
    return Surface(in.color * 0.9, vec3f(0.0), 1.0);
  }
  if (face == EAVE) {
    // The eaves' undersides: the walls' colour, deep in shade.
    return Surface(in.trimColor * 0.8, vec3f(0.0), EAVE_SHADE);
  }
  if (face == TOP || face == BOTTOM) {
    if (in.kind.z == LAMP || in.kind.z == SIGN) {
      return Surface(vec3f(0.3), vec3f(0.0), 1.0);
    }
    return Surface(topAlbedo(in, pixel), vec3f(0.0), 1.0);
  }
  if (face == GABLE) {
    return Surface(materialAlbedo(in.kind.z, in.color, in.local.x, in.local.y, in.size.w, pixel), vec3f(0.0), 1.0);
  }
  return wallSurface(in, pixel);
}

fn lit(in: PartOut, s: Surface) -> vec4f {
  let normal = normalize(in.normal);
  let ao = pow(in.light.x, props.occlusion) * s.reach;
  // Darker toward the ground, where little sky reaches.
  // Only for parts that stand on the ground: not a roof, a balcony or a sign.
  let grounded = in.extra.x <= 0.0;
  let foot = select(1.0, mix(FOOT_DARK, 1.0, smoothstep(in.extra.w, in.extra.w + FOOT_HEIGHT, in.local.y)), grounded);
  let sky = mix(props.seaFill, props.skyColor, normal.y * 0.5 + 0.5);
  let grey = dot(sky, vec3f(0.2126, 0.7152, 0.0722));
  let fill = mix(sky, vec3f(grey), FILL_GREY) * props.skyStrength * ao * foot;
  // Light thrown back up off the sunlit ground, on what faces out or down.
  let bounce = props.sunColor * props.sunStrength * max(props.sun.y, 0.0) * GROUND_BOUNCE * saturate(0.6 - 0.6 * normal.y) * ao;
  let shadow = mix(1.0, in.light.y, props.shadowStrength);
  let direct = props.sunColor * max(dot(normal, props.sun), 0.0) * shadow * props.sunStrength * mix(1.0, ao, props.occlusionSun) * mix(1.0, s.reach, 0.7) * mix(FOOT_SUN, 1.0, foot);
  return vec4f(s.albedo * (fill + bounce + direct) + s.glow, 1.0);
}

// Chart units a pixel covers at a fragment, found before any branch.
fn pixelOf(local: vec3f) -> f32 {
  let d = fwidth(local);
  return max(max(d.x, d.y), d.z);
}

@fragment
fn fs_main(in: PartOut) -> @location(0) vec4f {
  let pixel = pixelOf(in.local);
  return lit(in, surfaceOf(in, pixel));
}

// An open part's face as two coordinates across it and their extents.
struct FaceCoords {
  uv: vec2f,
  low: vec2f,
  high: vec2f,
}

fn faceCoords(in: PartOut) -> FaceCoords {
  let n = in.localNormal;
  let h = in.size.xy;
  let base = in.extra.x;
  let top = in.size.z;
  if (abs(n.y) > 0.5) {
    return FaceCoords(in.local.xz, -h, h);
  }
  if (abs(n.x) > 0.5) {
    return FaceCoords(vec2f(in.local.z, in.local.y), vec2f(-h.y, base), vec2f(h.y, top));
  }
  return FaceCoords(vec2f(in.local.x, in.local.y), vec2f(-h.x, base), vec2f(h.x, top));
}

// How near a face's edge a fragment lies.
fn edgeOf(c: FaceCoords) -> f32 {
  let d = min(c.uv - c.low, c.high - c.uv);
  return min(d.x, d.y);
}

// A fence's side: posts and rails, or on a tall fence posts, a top rail
// and a diamond mesh; nothing on its top or bottom.
fn keepFence(in: PartOut, c: FaceCoords, pixel: f32) -> bool {
  if (in.kind.y != WALL) {
    return false;
  }
  let low = in.extra.w;
  let top = in.size.z;
  let post = abs(fract(c.uv.x / FENCE_POSTS + 0.5) - 0.5) * FENCE_POSTS < FENCE_BAR * 0.6;
  let rail = top - in.local.y < FENCE_BAR || abs(in.local.y - mix(max(low, 0.0), top, 0.4)) < FENCE_BAR * 0.5;
  if (post || rail) {
    return true;
  }
  if (top - max(in.extra.x, 0.0) < TALL_FENCE) {
    return false;
  }
  // Too fine to draw far away: there the mesh is a faint haze, kept by its coverage.
  let cell = abs(fract(vec2f(c.uv.x + in.local.y, c.uv.x - in.local.y) / FENCE_MESH + 0.5) - 0.5) * FENCE_MESH;
  return min(cell.x, cell.y) < max(0.004, pixel * 0.35);
}

// An open part: what is kept of its box. A balcony keeps its slab and
// panel on every storey and its floor, open at its back against the wall;
// a stair its flights up its sides, a landing at each storey and their
// rails; a net its mesh and its frame; a frame its bars along every edge;
// a fence its posts and rails.
@fragment
fn fs_open(in: PartOut) -> @location(0) vec4f {
  let pixel = pixelOf(in.local);
  let style = u32(in.extra.y);
  let face = in.kind.y;
  let n = in.localNormal;
  let c = faceCoords(in);
  let edge = edgeOf(c);
  let rel = in.local.y - in.extra.x;
  let up = rel - floor(rel / STOREY) * STOREY;
  var albedo = in.color;
  if (style == BALCONY) {
    if (face == TOP) {
      if (edge > 0.03 || in.local.z < -in.size.y + 0.03) {
        discard;
      }
    } else if (face == WALL) {
      if (n.z < -0.5 || up > PANEL) {
        discard;
      }
      albedo = select(albedo, CONCRETE_COLOR * 0.9, up < SLAB);
    } else {
      albedo = CONCRETE_COLOR * 0.8;
    }
  } else if (style == STAIR) {
    // Flights rise from the front (+z) to the back on every storey.
    let t = (in.size.y - in.local.z) / (2.0 * in.size.y);
    let flight = up - t * STOREY;
    if (face == WALL) {
      let stringer = abs(n.x) > 0.5 && flight > -STRINGER && flight < PANEL;
      let landing = up < PANEL && (t > 0.85 || t < 0.15 || abs(n.z) > 0.5);
      if (!(stringer || landing)) {
        discard;
      }
      albedo = select(albedo * 0.85, albedo, flight > 0.0 && up > SLAB);
    } else if (face == TOP) {
      if (edge > 0.03) {
        discard;
      }
    }
  } else if (style == NET_STYLE) {
    if (face == BOTTOM) {
      discard;
    }
    let cell = abs(fract(c.uv / MESH + 0.5) - 0.5) * MESH;
    if (edge > BAR && min(cell.x, cell.y) > CORD) {
      discard;
    }
    albedo = select(NET_COLOR, STEEL_COLOR, edge <= BAR);
  } else if (style == FENCE_STYLE) {
    if (!keepFence(in, c, pixel)) {
      discard;
    }
  } else {
    if (face == BOTTOM || edge > BAR) {
      discard;
    }
  }
  return lit(in, Surface(albedo, vec3f(0.0), 1.0));
}

// The shadow: a patch of SHADOW_CELLS² cells over the ground, each corner
// on the baked height and lifted clear of it, reaching from round the part
// out along the way its shadow falls (town-draw.ts `SHADOW_CELLS`).
const SHADOW_CELLS = 6u;
const SHADOW_LIFT = 0.04;
// How dark the shadow is at its heart, and how soft its edge, chart units.
const SHADOW_DARK = 0.7;
const SHADOW_SOFT = 0.1;
// Heights the part is sliced at to sweep its outline along the sun.
const SHADOW_SLICES = 12u;

fn uvOf(xz: vec2f) -> vec2f {
  return (xz - props.origin) / props.side;
}

fn groundAt(xz: vec2f) -> f32 {
  return textureSampleLevel(height, linear, uvOf(xz), 0.0).r;
}

struct ShadowOut {
  @builtin(position) position: vec4f,
  // Chart units from the part's middle, in its own frame.
  @location(0) offset: vec2f,
  // Where a unit of height falls, in the part's frame.
  @location(1) @interpolate(flat) fall: vec2f,
  // Half the footprint, the height where it starts to taper, the top.
  @location(2) @interpolate(flat) size: vec4f,
  // The shape, whether it is hipped, the roof's ridge's half-length.
  @location(3) @interpolate(flat) shape: vec3f,
}

// A part's outline as it casts: its footprint and how high it stands
// before it tapers, and its top.
fn castOf(part: Part, shape: u32) -> vec4f {
  if (shape == ROOF) {
    return vec4f(part.half + part.style, part.base, part.base + part.rise);
  }
  if (shape == ROUND) {
    let top = part.base + part.wall;
    return vec4f(vec2f(part.half.x + part.style), top, top + part.rise);
  }
  let top = part.base + part.wall;
  return vec4f(part.half, top, top);
}

@vertex
fn vs_shadow(@builtin(vertex_index) vertex: u32, @builtin(instance_index) index: u32) -> ShadowOut {
  let part = partAt(index);
  let shape = shapeOf(part);
  let size = castOf(part, shape);
  let spin = spinOf(part.turn);
  // The spin's inverse is its transpose.
  let unspin = transpose(spin);
  let fall = -props.sun.xz / max(props.sun.y, 0.2);
  let reach = length(size.xy) + SHADOW_SOFT * 2.0;
  let far = fall * size.w;
  let low = min(vec2f(0.0), far) - reach;
  let high = max(vec2f(0.0), far) + reach;
  let cell = vertex / 6u;
  let corner = QUAD[vertex % 6u];
  let g = vec2f(vec2u(cell % SHADOW_CELLS, cell / SHADOW_CELLS) + corner) / f32(SHADOW_CELLS);
  let offset = mix(low, high, g);
  let xz = part.at + offset;
  var out: ShadowOut;
  out.position = props.viewProjection * vec4f(xz.x, groundAt(xz) + SHADOW_LIFT, xz.y, 1.0);
  out.offset = unspin * offset;
  out.fall = unspin * fall;
  out.size = size;
  let hipped = has(part, HIPPED);
  let ridge = select(size.y, max(part.half.y - part.half.x, 0.0), hipped);
  out.shape = vec3f(f32(shape), select(0.0, 1.0, hipped), ridge);
  return out;
}

fn boxDistance(p: vec2f, half: vec2f) -> f32 {
  let d = abs(p) - half;
  return length(max(d, vec2f(0.0))) + min(max(d.x, d.y), 0.0);
}

@fragment
fn fs_shadow(in: ShadowOut) -> @location(0) vec4f {
  let shape = u32(in.shape.x);
  let half = in.size.xy;
  let taper = in.size.z;
  let top = in.size.w;
  // The outline swept up the part, each slice moved along the sun by its
  // height: the nearest any slice comes is the distance to the shadow.
  var d = 1e9;
  var foot = 1e9;
  for (var k = 0u; k <= SHADOW_SLICES; k++) {
    let y = top * f32(k) / f32(SHADOW_SLICES);
    let t = saturate((y - taper) / max(top - taper, 1e-3));
    let p = in.offset - in.fall * y;
    var slice = 0.0;
    if (shape == ROUND) {
      slice = length(p) - half.x * (1.0 - t);
    } else if (shape == ROOF) {
      let along = mix(half.y, in.shape.z, t);
      slice = boxDistance(p, vec2f(half.x * (1.0 - t), along));
    } else {
      slice = boxDistance(p, half);
    }
    d = min(d, slice);
    if (k == 0u) {
      foot = slice;
    }
  }
  let shade = 1.0 - smoothstep(-SHADOW_SOFT, SHADOW_SOFT, d);
  // Darkest at the wall's foot, where the part meets the ground.
  let contact = 1.0 - smoothstep(0.0, 0.5, foot);
  let alpha = SHADOW_DARK * max(shade * mix(0.8, 1.0, contact), 0.5 * contact) * props.shadowStrength;
  if (alpha <= 0.002) {
    discard;
  }
  return vec4f(0.0, 0.0, 0.0, alpha);
}

// The wires (town-draw.ts `WIRE_SEGMENTS`): each a ribbon of segments
// hung between its two poles in a parabola, turned to face the camera in
// the film and at least a pixel wide; one thinner than a pixel is drawn a
// pixel wide and as faint as the share of it that it covers, so it
// neither flickers nor vanishes far away.
const WIRE_SEGMENTS = 16u;
const WIRE_COLOR = vec3f(0.018, 0.02, 0.022);
const WIRE_ALPHA = 0.9;
// The widest a wire is drawn, pixels.
const WIRE_WIDEST = 3.0;

struct WireOut {
  @builtin(position) position: vec4f,
  // −1 to 1 across the ribbon.
  @location(0) across: f32,
  // The share of a pixel the wire covers, and the ribbon's half width in pixels.
  @location(1) cover: vec2f,
}

fn wirePoint(a: vec3f, b: vec3f, t: f32, sag: f32) -> vec3f {
  return mix(a, b, t) - vec3f(0.0, 4.0 * sag * t * (1.0 - t), 0.0);
}

// A point in the film, pixels from its middle.
fn filmOf(p: vec3f) -> vec2f {
  let c = props.viewProjection * vec4f(p, 1.0);
  return c.xy / max(c.w, 1e-4) * 0.5 * props.viewport;
}

@vertex
fn vs_wire(@builtin(vertex_index) vertex: u32, @builtin(instance_index) index: u32) -> WireOut {
  let ends = wires[index * 3u];
  let others = wires[index * 3u + 1u];
  let shape = wires[index * 3u + 2u];
  let a = vec3f(ends.x, floors[u32(ends.w)].x + ends.z, ends.y);
  let b = vec3f(others.x, floors[u32(others.w)].x + others.z, others.y);
  let sag = shape.x;
  let radius = shape.y;
  let q = QUAD[vertex % 6u];
  let t = f32(vertex / 6u + q.x) / f32(WIRE_SEGMENTS);
  let p = wirePoint(a, b, t, sag);
  // Its heading in the film, from just behind to just ahead.
  let behind = filmOf(wirePoint(a, b, max(t - 0.01, 0.0), sag));
  let ahead = filmOf(wirePoint(a, b, min(t + 0.01, 1.0), sag));
  let heading = ahead - behind;
  let dir = select(vec2f(1.0, 0.0), normalize(heading), length(heading) > 1e-5);
  let perpendicular = vec2f(-dir.y, dir.x);
  // Its width in pixels: its diameter seen upright and seen level across it.
  let span = b - a;
  let level = normalize(vec3f(-span.z, 0.0, span.x) + vec3f(1e-6, 0.0, 0.0));
  let here = filmOf(p);
  // Held to a few pixels, so one passing close to the camera stays a line.
  let wide = min(max(length(filmOf(p + vec3f(0.0, 2.0 * radius, 0.0)) - here), length(filmOf(p + level * 2.0 * radius) - here)), WIRE_WIDEST);
  // A pixel of soft edge on each side.
  let halfWidth = 0.5 * max(wide, 1.0) + 0.5;
  let side = f32(q.y) * 2.0 - 1.0;
  var clip = props.viewProjection * vec4f(p, 1.0);
  clip = vec4f(clip.xy + perpendicular * side * halfWidth / (0.5 * props.viewport) * clip.w, clip.zw);
  var out: WireOut;
  out.position = clip;
  out.across = side;
  out.cover = vec2f(min(wide, 1.0), halfWidth);
  return out;
}

@fragment
fn fs_wire(in: WireOut) -> @location(0) vec4f {
  let edge = saturate((1.0 - abs(in.across)) * in.cover.y);
  let alpha = edge * in.cover.x * WIRE_ALPHA;
  if (alpha < 0.003) {
    discard;
  }
  return vec4f(WIRE_COLOR * props.skyStrength, alpha);
}
