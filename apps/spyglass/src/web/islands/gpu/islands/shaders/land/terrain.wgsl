// The terrain: the clipmap mesh (clipmap.ts) over the maps' texel grid,
// heights read from the height map, coloured from the paint map and lit
// by the sun with the light map's normal,
// occlusion and shadow. A debug view drapes one map over the same mesh in
// place of the paint.
//
// Texel space: texel (i, j)'s centre is at (i, j); a world point p lies at
// (p.xz − origin) / texel − 0.5. Chart (x, y) is world (x, 0, y). The mesh's
// lattice runs in steps of 1 / SUBTEXELS of a texel, so up close a cell is
// smaller than a texel: each vertex rebuilds the land's profile from the
// height map's smooth inputs, read between texels, and a cliff steeper than
// a texel rises over many vertices instead of sawing into teeth. Past the
// grid's edge every read clamps onto the edge texel, so the ground runs on
// flat at the edge's height and colour as far as the mesh reaches.

import { grassColor, grassSheen, grassTilt, grassWind } from "./grass.wgsl";
import { Land, landHeight } from "./land.wgsl";
import { sandRipples, specks } from "../sea/sand.wgsl";
import { flowKey, mapRamp, ringKey } from "./views.wgsl";

struct Camera {
  viewProjection: mat4x4f,
  // Where the eye is, world space: the turf's sheen faces it.
  eye: vec3f,
  // Seconds on the clock the water and the wind run by.
  time: f32,
}

// Where the levels lie this frame (clipmap.ts `ClipLayout`), in lattice
// steps of 1 / SUBTEXELS texel.
struct Clip {
  origin: vec2i,
  stride: i32,
  cells: u32,
}

// The maps' square (maps.ts `MapFrame`), and how to draw over it.
struct Grid {
  origin: vec2f,
  texel: f32,
  resolution: u32,
  // 0 shaded; 1 + the map's index in VIEWED_MAPS for a debug view.
  view: u32,
  // Distance ramp's reach, chart units; the floor's depth; the land's top.
  ramp: vec3f,
  // The flow view's full brightness, chart units per second.
  flowSpeed: f32,
  land: Land,
}

struct Look {
  // Toward the sun, world space.
  sun: vec3f,
  sunStrength: f32,
  sunColor: vec3f,
  skyStrength: f32,
  // The fill from above, and from below off the sea.
  skyColor: vec3f,
  // How far the sun wraps round gentle ground.
  softLight: f32,
  seaFill: vec3f,
  // How much sun a cast shadow takes away.
  shadowStrength: f32,
  // The cliff rock, and how far it takes its island's hue.
  rock: vec3f,
  rockTint: f32,
  // Warm light thrown up off sunlit sand and shallows, and how strong.
  bounce: vec3f,
  bounceStrength: f32,
  // The shallow floor's details (sea/sand.wgsl): the ripples' strength and
  // spacing, the specks' strength, cell and share of cells, and colour.
  ripples: f32,
  rippleSpacing: f32,
  specks: f32,
  speckSize: f32,
  speck: vec3f,
  speckDensity: f32,
  // The top level's depth: the shallows the details fade by.
  top: f32,
  // The baked occlusion's power (1 as baked), and the share of it the sun
  // takes too, so creases and the feet of walls sit in the ground.
  occlusion: f32,
  occlusionSun: f32,
  // How strongly the files map shows on the ground, 0 for not at all.
  files: f32,
  // The turf on the tops (grass.wgsl): its lush and dry colours, how much
  // of the top it covers in place of the island's cap, and its sheen.
  grassLush: vec3f,
  grass: f32,
  grassDry: vec3f,
  grassSheen: f32,
  // The wind over the turf (grass.wgsl `grassWind`): the way it blows (the
  // swell's heading), how hard, how fast its gusts run and how long they are.
  windHeading: vec2f,
  wind: f32,
  windSpeed: f32,
  gustSize: f32,
}

@group(0) @binding(0) var<uniform> camera: Camera;
@group(0) @binding(1) var<uniform> clip: Clip;
@group(0) @binding(2) var<uniform> grid: Grid;
@group(0) @binding(3) var<uniform> look: Look;
@group(0) @binding(4) var height: texture_2d<f32>;
@group(0) @binding(5) var paint: texture_2d<f32>;
@group(0) @binding(6) var light: texture_2d<f32>;
@group(0) @binding(7) var distance: texture_2d<f32>;
@group(0) @binding(8) var coverage: texture_2d<f32>;
@group(0) @binding(9) var islands: texture_2d<u32>;
@group(0) @binding(10) var mapSampler: sampler;
// The placeholder colours, linear RGBA, one per island in chart order: the
// paint map's own (maps.ts `placeholderColors`), so the views agree.
@group(0) @binding(11) var<storage, read> islandColors: array<vec4f>;
@group(0) @binding(12) var flow: texture_2d<f32>;
// r: the sun's visibility at the sea surface (the water's shadow).
@group(0) @binding(13) var shade: texture_2d<f32>;
// r: the bank whose plate each sea texel stands on, its id + 1 (maps.ts `rings`).
@group(0) @binding(14) var rings: texture_2d<u32>;
// The chart's files as discs, rgb by kind premultiplied, a their cover
// (maps.ts `files`): the files view, and the shaded view by `look.files`.
@group(0) @binding(15) var files: texture_2d<f32>;
// r: the ground a road, parcel or building reserves, easing off over about
// a unit past its edge (maps.ts `zoning`, world.ts `ZONING_CHANNELS`).
@group(0) @binding(16) var zoning: texture_2d<f32>;

struct VertexOut {
  @builtin(position) position: vec4f,
  @location(0) world: vec3f,
}

// Lattice steps a texel (clipmap.ts `SUBTEXELS`).
const SUBTEXELS = 4.0;

// The lattice point `t` in texel space.
fn latticeTexel(t: vec2i) -> vec2f {
  return vec2f(t) / SUBTEXELS;
}

// The ground at `uv`: the land's profile on the height map's rim distance
// and coast floor, read bilinear; at sea the floor itself.
fn surfaceHeight(uv: vec2f) -> f32 {
  let h = textureSampleLevel(height, mapSampler, uv, 0.0);
  return landHeight(grid.land, h.g, h.b);
}

fn latticeHeight(t: vec2i) -> f32 {
  return surfaceHeight((latticeTexel(t) + 0.5) / f32(grid.resolution));
}

// A level's lattice: its first vertex, in lattice steps, and its stride.
struct Level {
  corner: vec2i,
  stride: i32,
}

fn levelOf(level: u32) -> Level {
  let n = i32(clip.cells);
  // Each level is centred on the one inside it: back by half the growth.
  let back = (n / 2) * clip.stride * ((1 << level) - 1);
  return Level(clip.origin - vec2i(back), clip.stride << level);
}

// Where the rim's distance inland changes slower than this, against the
// chart unit a unit it runs at off a plain coast, its way is too unsure to
// move a vertex along.
const SNAP_GRADIENT = 0.5;
// A vertex snaps from this many strides off the foot or the crest: past
// half, so even across a cell's diagonal one corner reaches the line.
const SNAP_REACH = 0.75;

// A vertex at texel `at`, `stride` texels from its neighbours, moved onto
// the cliff's foot (the coast) or its crest (the rim's end) where one runs
// within SNAP_REACH strides of it, so the mesh's edges follow the cliff. It
// moves along the way inland, or only along `along` (a unit axis) when it
// must stay on a line; zero leaves it free. Neighbours keep their order.
fn snapped(at: vec2f, stride: f32, along: vec2f) -> vec2f {
  let n = f32(grid.resolution);
  let uv = (at + 0.5) / n;
  let inland = textureSampleLevel(height, mapSampler, uv, 0.0).g;
  let reach = SNAP_REACH * stride * grid.texel;
  let crest = grid.land.rimWidth;
  if (inland < -reach || inland > crest + reach) {
    return at;
  }
  let half = 0.5 / n;
  let gradient = vec2f(
    textureSampleLevel(height, mapSampler, uv + vec2f(half, 0.0), 0.0).g - textureSampleLevel(height, mapSampler, uv - vec2f(half, 0.0), 0.0).g,
    textureSampleLevel(height, mapSampler, uv + vec2f(0.0, half), 0.0).g - textureSampleLevel(height, mapSampler, uv - vec2f(0.0, half), 0.0).g,
  ) / grid.texel;
  let way = select(gradient / max(length(gradient), 1e-6), along, any(along != vec2f(0.0)));
  let rate = dot(gradient, way);
  if (abs(rate) < SNAP_GRADIENT) {
    return at;
  }
  let contour = select(crest, 0.0, abs(inland) < abs(inland - crest));
  let run = (contour - inland) / rate;
  if (abs(run) > reach) {
    return at;
  }
  return at + way * run / grid.texel;
}

// The level's local vertex `g`: texel x, z and height, snapped onto the
// cliff. A vertex the next level out shares (on this level's outer edge,
// at its stride) or the next level in shares (round a ring's hole) moves
// only along that edge, and both levels move it alike; on the outer edge
// every other one has no partner in the coarser ring: it stands midway
// between its two neighbours, on the ring's straight edge, so nothing
// cracks. The square's corners stay put.
fn vertexAt(l: Level, g: vec2i, level: u32) -> vec3f {
  let n = i32(clip.cells);
  let quarter = n / 4;
  let outer = vec2<bool>(g.x == 0 || g.x == n, g.y == 0 || g.y == n);
  let inHole = all(g >= vec2i(quarter)) && all(g <= vec2i(n - quarter));
  let hole = vec2<bool>(g.x == quarter || g.x == n - quarter, g.y == quarter || g.y == n - quarter) & vec2<bool>(inHole && level > 0u);
  let stride = select(1, 2, any(outer)) * l.stride;
  let edge = outer | hole;
  if (all(edge)) {
    let t = l.corner + g * l.stride;
    return vec3f(latticeTexel(t), latticeHeight(t));
  }
  // An edge across x runs along x, and one across y along y.
  let along = select(vec2f(0.0), select(vec2f(1.0, 0.0), vec2f(0.0, 1.0), edge.x), any(edge));
  let alongX = outer.y && (g.x & 1) == 1;
  let alongY = outer.x && (g.y & 1) == 1;
  if (alongX || alongY) {
    let step = select(vec2i(0, 1), vec2i(1, 0), alongX);
    return 0.5 * (cornerAt(l, g - step, stride, along) + cornerAt(l, g + step, stride, along));
  }
  return cornerAt(l, g, stride, along);
}

// Lattice vertex `g` of level `l`, snapped at `stride` along `along`.
fn cornerAt(l: Level, g: vec2i, stride: i32, along: vec2f) -> vec3f {
  let moved = snapped(latticeTexel(l.corner + g * l.stride), f32(stride) / SUBTEXELS, along);
  return vec3f(moved, surfaceHeight((moved + 0.5) / f32(grid.resolution)));
}

// Past the `(cells + 1)²` corners come the cells' centres, one a cell
// (clipmap.ts `levelIndices`). Four triangles fan round each centre, and
// the centre stands midway along whichever of the cell's diagonals joins
// the nearer heights: the cell is split along the ground's contour, never
// across it, so with its corners on the cliff's foot and crest a cliff
// steeper than a cell keeps a straight edge instead of teeth.
@vertex
fn vs_main(@builtin(vertex_index) vertex: u32, @builtin(instance_index) level: u32) -> VertexOut {
  let across = clip.cells + 1u;
  let corners = across * across;
  let l = levelOf(level);
  var p: vec3f;
  if (vertex < corners) {
    p = vertexAt(l, vec2i(i32(vertex % across), i32(vertex / across)), level);
  } else {
    let cell = vertex - corners;
    let g = vec2i(i32(cell % clip.cells), i32(cell / clip.cells));
    let a = vertexAt(l, g, level);
    let b = vertexAt(l, g + vec2i(1, 0), level);
    let c = vertexAt(l, g + vec2i(0, 1), level);
    let d = vertexAt(l, g + vec2i(1, 1), level);
    p = select(0.5 * (b + c), 0.5 * (a + d), abs(a.z - d.z) < abs(b.z - c.z));
  }

  let xz = grid.origin + (p.xy + 0.5) * grid.texel;
  let world = vec3f(xz.x, p.z, xz.y);
  var out: VertexOut;
  out.position = camera.viewProjection * vec4f(world, 1.0);
  out.world = world;
  return out;
}

// The light map's normal: x and z stored, y implied up.
fn mapNormal(l: vec4f) -> vec3f {
  return vec3f(l.x, sqrt(max(0.0, 1.0 - l.x * l.x - l.y * l.y)), l.y);
}

// How the ground faces the sun, the sun wrapped round gentle ground so
// rolling tops read smooth while steep faces keep their shadow side.
fn softFacing(normal: vec3f) -> f32 {
  let wrap = look.softLight * smoothstep(0.72, 0.95, normal.y);
  let rise = max(look.sun.y, 0.05);
  return max((dot(normal, look.sun) + wrap) / (rise + wrap) * rise, 0.0);
}

// The ground around `uv`, from the rebuilt surface half a texel either
// side: its normal, smooth up a cliff steeper than a texel where the light
// map's per-texel normal would stripe it; and which way is inland.
struct Ground {
  normal: vec3f,
  inland: vec2f,
}

fn groundAt(uv: vec2f) -> Ground {
  let half = 0.5 / f32(grid.resolution);
  let east = textureSampleLevel(height, mapSampler, uv + vec2f(half, 0.0), 0.0);
  let west = textureSampleLevel(height, mapSampler, uv - vec2f(half, 0.0), 0.0);
  let south = textureSampleLevel(height, mapSampler, uv + vec2f(0.0, half), 0.0);
  let north = textureSampleLevel(height, mapSampler, uv - vec2f(0.0, half), 0.0);
  let h = vec4f(
    landHeight(grid.land, east.g, east.b),
    landHeight(grid.land, west.g, west.b),
    landHeight(grid.land, south.g, south.b),
    landHeight(grid.land, north.g, north.b),
  );
  let normal = normalize(vec3f(h.y - h.x, grid.texel, h.w - h.z));
  let toward = vec2f(east.g - west.g, south.g - north.g);
  return Ground(normal, toward / max(length(toward), 1e-6));
}

// Paint is read this many texels to either side of the coast, so the land's
// colour and the sea's meet on the rebuilt coast at the pixel, not on the
// paint's texel-wide edge.
const COAST_REACH = 1.5;

// Up a face whose up falls from the first to the second, the coast is
// where it meets the water, not where the rim's distance crosses zero:
// across a wall the distance hardly moves, and would tear into teeth.
const WALL_UP = vec2f(0.6, 0.3);

// How much of the land stands at a pixel `inland` of the coast and `y`
// high: joined over a pixel, by the distance on gentle ground and by the
// height up a wall.
fn landCover(inland: f32, y: f32, up: f32) -> f32 {
  let across = smoothstep(-0.5, 0.5, inland / max(fwidth(inland), 1e-4));
  let above = smoothstep(-0.5, 0.5, y / max(fwidth(y), 1e-4));
  return mix(across, above, smoothstep(WALL_UP.x, WALL_UP.y, up));
}

// The unlit colour at `uv`, `cover` of it land: the land's and the sea's
// paint, each read clear of the coast.
fn coastPaint(uv: vec2f, ground: Ground, cover: f32) -> vec3f {
  let reach = ground.inland * COAST_REACH / f32(grid.resolution);
  let land = textureSampleLevel(paint, mapSampler, uv + reach, 0.0).rgb;
  let sea = textureSampleLevel(paint, mapSampler, uv - reach, 0.0).rgb;
  return mix(sea, land, cover);
}

// The land is rock where its up falls from the first to the second: from a
// slope of about 0.6 to all rock by about 1.3.
const CLIFF_UP = vec2f(0.86, 0.62);

fn luma(c: vec3f) -> f32 {
  return dot(c, vec3f(0.2126, 0.7152, 0.0722));
}

// The cliff rock on the land's steep rim over `top`, tinted toward the
// island's cap.
fn withRock(top: vec3f, cap: vec3f, normal: vec3f, cover: f32) -> vec3f {
  let hue = cap / max(luma(cap), 1e-3);
  let rock = look.rock * mix(vec3f(1.0), hue, look.rockTint);
  let cliff = smoothstep(CLIFF_UP.x, CLIFF_UP.y, normal.y) * cover;
  return mix(top, rock, cliff);
}

// The bounce reaches this far out from a face, texels, to the ground that
// throws it; ground this high or deep throws none.
const BOUNCE_REACH = 6.0;
const BOUNCE_LEVEL = vec2f(1.0, 4.0);

// Warm light thrown up onto faces that look out and down, from the ground
// in front of them where it lies near the water and in the sun.
fn bounceLight(uv: vec2f, normal: vec3f) -> vec3f {
  let out = normal.xz / max(length(normal.xz), 1e-3);
  let front = uv + out * BOUNCE_REACH / f32(grid.resolution);
  let level = 1.0 - smoothstep(BOUNCE_LEVEL.x, BOUNCE_LEVEL.y, abs(surfaceHeight(front)));
  let lit = textureSampleLevel(light, mapSampler, front, 0.0).w;
  let facing = saturate(0.65 - 0.6 * normal.y);
  return look.bounce * look.bounceStrength * level * mix(0.35, 1.0, lit) * facing;
}

// The floor's details on the shallows, `depth` deep at p: the ripples
// shade the sand, the specks gild it, more on the levels' lips.
fn withSand(color: vec3f, p: vec2f, depth: f32, coast: f32, up: f32, footprint: f32) -> vec3f {
  let shallow = smoothstep(0.02, 0.3, depth) * (1.0 - smoothstep(look.top, 4.0 * look.top, depth));
  if (shallow <= 0.0) {
    return color;
  }
  var sand = color * (1.0 + look.ripples * sandRipples(p, coast, look.rippleSpacing, footprint) * shallow);
  let lip = 1.0 - smoothstep(0.93, 0.995, up);
  let gold = specks(p, look.speckSize, look.speckDensity * mix(0.35, 1.0, lip), footprint);
  return mix(sand, look.speck, gold * look.specks * shallow);
}

// The files painted on the ground, lit with it: each disc's own colour
// (the map's is premultiplied) over the base, by its cover. Not read at
// all while `look.files` is 0.
fn withFiles(base: vec3f, uv: vec2f) -> vec3f {
  if (look.files <= 0.0) {
    return base;
  }
  let f = textureSampleLevel(files, mapSampler, uv, 0.0);
  return mix(base, f.rgb / max(f.a, 1e-4), f.a * look.files);
}

// The turf's soil, where it breaks over the crest onto the rock.
const SOIL = vec3f(0.11, 0.065, 0.035);
// Packed earth, where the zoning reserves the ground and no turf grows:
// whatever the surfaces and structures leave uncovered there. It takes
// the cap's place within the first quarter of the reserve's ease, so the
// pale cap never shows between it and the turf.
const PACKED_EARTH = vec3f(0.2, 0.17, 0.13);
// The turf grows where the ground's up is past the first, whole by the
// second; the soil shows between the rock's and the turf's.
const TURF_UP = vec2f(0.8, 0.92);
const SOIL_UP = vec2f(0.66, 0.8);
// How far the hummocks tilt the turf's normal, and the wind at full.
const HUMMOCK_TILT = 0.14;
const WIND_TILT = 0.4;

// How much of the ground at `uv` is turf, `inland` of the coast.
fn turfCover(inland: f32, normal: vec3f, cover: f32) -> f32 {
  return look.grass * cover * smoothstep(0.0, grid.land.rimWidth, inland) * smoothstep(TURF_UP.x, TURF_UP.y, normal.y);
}

// The island's top, turf over its cap by `turf`, its soil showing at the
// crest. `occlusion` is the baked one: a hollow's turf runs greener, and
// `laid` how flat the wind lays it.
fn withTurf(cap: vec3f, p: vec2f, inland: f32, normal: vec3f, cover: f32, turf: f32, occlusion: f32, laid: f32, footprint: f32) -> vec3f {
  if (look.grass <= 0.0) {
    return cap;
  }
  let edge = 1.0 - smoothstep(grid.land.rimWidth, grid.land.rimWidth + grid.land.lipWidth + 6.0, inland);
  let hollow = saturate((0.92 - occlusion) * 4.0);
  let grass = grassColor(p, look.grassLush, look.grassDry, edge, hollow, laid, footprint);
  var top = mix(cap, grass, turf);
  let soil = smoothstep(SOIL_UP.x, SOIL_UP.y, normal.y) * (1.0 - smoothstep(TURF_UP.x, TURF_UP.y, normal.y));
  return mix(top, SOIL, soil * cover * look.grass * 0.85);
}

fn shaded(uv: vec2f, p: vec3f, footprint: f32) -> vec3f {
  let l = textureSampleLevel(light, mapSampler, uv, 0.0);
  let ground = groundAt(uv);
  let heights = textureSampleLevel(height, mapSampler, uv, 0.0);
  let cover = landCover(heights.g, p.y, ground.normal.y);
  let reserved = textureSampleLevel(zoning, mapSampler, uv, 0.0).r;
  let turf = turfCover(heights.g, ground.normal, cover) * (1.0 - reserved);
  var wind = vec4f(0.0);
  if (look.wind > 0.0 && turf > 0.0) {
    wind = grassWind(p.xz, look.windHeading, camera.time, look.windSpeed, look.gustSize, footprint) * look.wind;
  }
  let tilt = (grassTilt(p.xz, footprint) * HUMMOCK_TILT - wind.xy * WIND_TILT) * turf;
  let normal = normalize(ground.normal - vec3f(tilt.x, 0.0, tilt.y));
  let cap = coastPaint(uv, ground, cover);
  let laid = saturate(wind.z);
  let earth = mix(cap, PACKED_EARTH, saturate(reserved * 4.0) * cover);
  var top = withTurf(earth, p.xz, heights.g, ground.normal, cover * (1.0 - reserved), turf, l.z, laid, footprint);
  top *= 1.0 + 0.28 * wind.w * turf;
  var base = withRock(top, cap, ground.normal, cover);
  if (cover < 0.5) {
    let coast = textureSampleLevel(distance, mapSampler, uv, 0.0).r;
    base = withSand(base, p.xz, -heights.r, coast, normal.y, footprint);
  }
  base = withFiles(base, uv);
  let ao = pow(l.z, look.occlusion);
  let fill = mix(look.seaFill, look.skyColor, normal.y * 0.5 + 0.5) * look.skyStrength * ao;
  let direct = look.sunColor * softFacing(normal) * mix(1.0, l.w, look.shadowStrength) * look.sunStrength * mix(1.0, ao, look.occlusionSun);
  let lit = base * (fill + direct + bounceLight(uv, normal) * ao);
  let sheen = grassSheen(normal, normalize(camera.eye - p)) * turf * look.grassSheen * (1.0 + laid);
  return lit + look.grassDry * sheen * (fill + 0.6 * direct);
}

fn mapTexel(uv: vec2f) -> vec2i {
  return vec2i(clamp(uv * f32(grid.resolution), vec2f(0.0), vec2f(f32(grid.resolution) - 1.0)));
}

fn debugView(uv: vec2f, fw: f32) -> vec3f {
  var color: vec3f;
  switch grid.view {
    case 1u: {
      let d = textureSampleLevel(distance, mapSampler, uv, 0.0).r;
      color = mapRamp(d, grid.ramp.x, fw);
    }
    case 2u: {
      let texel = vec2i(clamp(uv * f32(grid.resolution), vec2f(0.0), vec2f(f32(grid.resolution) - 1.0)));
      let index = textureLoad(islands, texel, 0).r;
      color = select(vec3f(0.2), islandColors[min(index, arrayLength(&islandColors)) - 1u].rgb, index > 0u);
    }
    case 3u: {
      color = vec3f(textureSampleLevel(coverage, mapSampler, uv, 0.0).r);
    }
    case 4u: {
      let h = textureLoad(height, vec2i(clamp(uv * f32(grid.resolution), vec2f(0.0), vec2f(f32(grid.resolution) - 1.0))), 0).r;
      // Sea from navy at the floor to pale at sea level; land from green to white at the top.
      let sea = mix(vec3f(0.02, 0.04, 0.16), vec3f(0.45, 0.75, 0.95), saturate(1.0 + h / max(grid.ramp.y, 1e-3)));
      let land = mix(vec3f(0.08, 0.3, 0.1), vec3f(1.0), saturate(h / max(grid.ramp.z, 1e-3)));
      color = select(sea, land, h > 0.0);
    }
    case 5u: {
      let d = textureSampleLevel(distance, mapSampler, uv, 0.0).r;
      color = ringKey(textureLoad(rings, mapTexel(uv), 0).r, d);
    }
    case 6u: {
      let f = textureSampleLevel(flow, mapSampler, uv, 0.0);
      let d = textureSampleLevel(distance, mapSampler, uv, 0.0).r;
      let xz = grid.origin + uv * grid.texel * f32(grid.resolution);
      color = flowKey(f, d, xz, grid.flowSpeed, fw);
    }
    case 7u: {
      let l = textureSampleLevel(light, mapSampler, uv, 0.0);
      let direct = max(dot(mapNormal(l), look.sun), 0.0) * l.w;
      color = vec3f(l.z * (0.25 + 0.75 * direct));
    }
    case 8u: {
      // The sun at the sea surface, grey; land, which the water never
      // reads, a dim brown apart from any shadow.
      let d = textureSampleLevel(distance, mapSampler, uv, 0.0).r;
      let sun = textureSampleLevel(shade, mapSampler, uv, 0.0).r;
      color = select(vec3f(0.15 + 0.8 * sun), vec3f(0.3, 0.2, 0.12), d < 0.0);
    }
    case 10u: {
      // The files over the paint, dimmed so the discs stand out.
      let f = textureSampleLevel(files, mapSampler, uv, 0.0);
      let ground = textureSampleLevel(paint, mapSampler, uv, 0.0).rgb * 0.4;
      color = f.rgb + ground * (1.0 - f.a);
    }
    case 11u: {
      // The zoning: reserved ground red, trees green, shrubs blue, open
      // ground lifting the dimmed paint.
      let z = textureSampleLevel(zoning, mapSampler, uv, 0.0);
      let ground = textureSampleLevel(paint, mapSampler, uv, 0.0).rgb * (0.15 + 0.25 * z.a);
      color = ground * (1.0 - z.r) + vec3f(0.8 * z.r, 0.7 * z.g, 0.8 * z.b);
    }
    default: {
      color = textureSampleLevel(paint, mapSampler, uv, 0.0).rgb;
    }
  }
  return color;
}

@fragment
fn fs_main(in: VertexOut) -> @location(0) vec4f {
  let side = grid.texel * f32(grid.resolution);
  let uv = (in.world.xz - grid.origin) / side;
  let d = textureSampleLevel(distance, mapSampler, uv, 0.0).r;
  let fw = fwidth(d);
  if (grid.view == 0u) {
    return vec4f(shaded(uv, in.world, length(fwidth(in.world.xz))), 1.0);
  }
  return vec4f(debugView(uv, fw), 1.0);
}
