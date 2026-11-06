// The water, as a fullscreen composite over the film: the terrain pass's
// colour and reversed-Z depth (depth = near / view distance, 0 for nothing
// drawn). Runs at the output's resolution and samples the film by uv, so a
// film smaller than the output (render scale) is upsampled here. For each
// pixel, in order:
//
//   1. plane hit: the view ray meets the sea plane, y = 0;
//   2. pass-through: terrain nearer than the plane shows as it is, but
//      for the swash running up a beach and the wet sand under it;
//   3. thickness: the distance along the ray from the plane to the terrain,
//      or, past the mesh, to the open floor at −openDepth (the depth the
//      seabed map eases onto at its edge, sunk past what the water shows);
//   4. refraction: the floor sample moves by the wave normal times the
//      thickness, and falls back to the unrefracted one where it lands on
//      terrain nearer than the plane (land above water);
//   5. the floor's detail: a pale line at each sea step's lip, and the
//      caustics on the shallow floor;
//   6. absorption and scatter: the floor fades per channel by the
//      water's transmittance (sea/surface.wgsl `transmittance`: the
//      brightness by `visibleDepth`, the tint by `depthCurve`) as the
//      water's colour builds by one less it, the chart's legend at the
//      floor's depth (`legend` of it), shaded by the floor's relief and
//      lit on each riser's sunward side; the water's colour is in the
//      land's shadow on the sea surface (the shade map), all but
//      `shadowAmbient` of it;
//   7. the shore: the glow of the sand under a beach, never on a drop-off,
//      the surf where the flow map says the swell breaks, and the wash
//      against a drop-off's wall;
//   8. reflection: an analytic sky, mixed in by Schlick's Fresnel, in the
//      same shadow;
//   9. specular: a sun lobe on a normal of its own, shadowed by the light
//      map.
//
// Then haze: everything below the horizon fades with distance from the
// cool near haze to the warm far one, the horizon's, so the sea meets the
// sky without a line. Last, over everything, the selection: the chosen
// island's land or ring's plates filled and outlined, the hovered one
// outlined.
//
// With water off (debug views, the bench's terrain alone, the dry shot)
// only the sky is added. Everything here is linear, and so is what it
// writes: the post (post.ts) adds the bloom and the vignette, encodes and
// anti-aliases.
//
// The sea's layers are pure modules in sea/: the waves, normals, sky,
// Fresnel, glint, lip lines and caustics in surface.wgsl; the surf and the
// beach's glow in shore.wgsl. This file owns the bindings and the order.

import { farShare, pastSquare, squareUv } from "../maps/frame.wgsl";
import { Bathymetry, openShareOf } from "../sea/bathymetry.wgsl";
import { bandColor } from "../sea/floor.wgsl";
import { cliffWash, FOAM, shoal, surf, swash } from "../sea/shore.wgsl";
import { caustics, floorRelief, fresnel, glint, lipLine, riserRim, rimmed, sky, transmittance, waterLight, waveSurface } from "../sea/surface.wgsl";

// Charts whose rings map can't hold every bank (bake-layout.ts
// `capacityOf`): `rings` is then selection-cache.ts's resolved flags, and
// `members` goes unread.
override SCALABLE_SELECTION: bool = false;

struct Eye {
  viewProjection: mat4x4f,
  eye: vec3f,
  near: f32,
  forward: vec3f,
  // tan(fov / 2) across.
  apertureX: f32,
  right: vec3f,
  // tan(fov / 2) up.
  apertureY: f32,
  up: vec3f,
  time: f32,
}

struct Grid {
  origin: vec2f,
  texel: f32,
  resolution: u32,
  // The seabed map's square (maps.ts `seabed`): its corner and side, chart
  // units. Past the grid the floor is lit by its normal.
  seabedOrigin: vec2f,
  seabedSide: f32,
}

struct Water {
  // Per channel, the optical depth at `clarity` (look.ts `waterOptics`).
  absorption: vec3f,
  // 0 passes the film through with sky only; 1 draws the water.
  enabled: f32,
  // The depth the floor is seen at the shallow colour; the brightness's
  // power (from `visibleDepth`); the tint's curve; how much of the water's
  // own light survives in the land's shadow.
  clarity: f32,
  depthPower: f32,
  depthCurve: f32,
  shadowAmbient: f32,
  // What the water's own colour builds to in the deep.
  scatter: vec3f,
  reflection: f32,
  sun: vec3f,
  specular: f32,
  sunColor: vec3f,
  // How far a unit of thickness moves the floor sample per unit of wave slope.
  refraction: f32,
  horizon: vec3f,
  // Multiplies the spectrum's amplitudes; 0 is a flat plane.
  waveStrength: f32,
  zenith: vec3f,
  // The haze's optical depth per eye height of distance past the first.
  haze: f32,
  hazeNear: vec3f,
  seaLines: f32,
  hazeFar: vec3f,
  // The deep floor's depth, where the platform's slope comes down to.
  floorDepth: f32,
  // The open floor past the mesh: its colour, lit.
  floorColor: vec3f,
  // The top level's depth: the shallows the glow and the caustics fade by.
  top: f32,
  seaLine: vec3f,
  shoalGlow: f32,
  // How far off the coast the beach's glow reaches.
  shoalReach: f32,
  surf: f32,
  surfSpacing: f32,
  // How fast the surf's crests roll ashore, chart units a second.
  surfSpeed: f32,
  caustics: f32,
  causticSize: f32,
  // How far the water's own colour is the chart's legend at the floor's
  // depth rather than `scatter`, 0–1.
  legend: f32,
  // How strongly the floor's relief shades the water's colour, and how
  // bright each riser's sunward rim is; 0 for none.
  relief: f32,
  rim: f32,
  // The open floor past the mesh: its depth, the seabed map's at its edge
  // (map-uniforms.ts `openFloorDepth`), sunk far past what the water shows.
  openDepth: f32,
  // How far the open sea's floor keeps its relief through the deep, 0–1:
  // where the seascape has taken over (the height map's a), the deep's calm
  // gives way by this much. The platform and its fall are untouched.
  seascapeRelief: f32,
  // The most thickness the refraction moves the floor sample by: past it
  // the deep floor wavers no more than the shelf's.
  refractionReach: f32,
  // The wash on a wall: its strength (0 for none), how far out its rings
  // spread, chart units, and seconds between them.
  wash: f32,
  washWidth: f32,
  washPeriod: f32,
  // The swash up a beach: its strength (0 for none), how high it runs,
  // chart units, and seconds between swashes; how dark wet sand is.
  swash: f32,
  swashReach: f32,
  swashPeriod: f32,
  wetSand: f32,
  // The platform's slope's width past its escarpment (bathymetry.wgsl
  // `Bathymetry`): how far past its edge the open sea's floor takes over.
  slopeWidth: f32,
  // The legend: rgb, and w the depth each colour is reached at.
  bands: array<vec4f, 6>,
  // kx, kz (radians per chart unit), angular frequency, amplitude.
  waves: array<vec4f, 32>,
}

// What is chosen and hovered (pick.wgsl keeps it): an island (its index
// + 1) or a ring (its bank's id + 1), 0 for none.
struct Selection {
  island: u32,
  ring: u32,
  hoverIsland: u32,
  hoverRing: u32,
}

struct Highlight {
  // The fill's and the outline's strength, 0 for none, and their colour.
  fill: f32,
  outline: f32,
  // How strongly a chosen ring's islands take the fill, against its plates.
  memberFill: f32,
  // How much the rest darkens while something is chosen.
  dim: f32,
  color: vec3f,
}

@group(0) @binding(0) var<uniform> eye: Eye;
@group(0) @binding(1) var<uniform> grid: Grid;
@group(0) @binding(2) var<uniform> water: Water;
@group(0) @binding(3) var film: texture_2d<f32>;
@group(0) @binding(4) var filmDepth: texture_depth_2d;
@group(0) @binding(5) var filmSampler: sampler;
@group(0) @binding(6) var height: texture_2d<f32>;
@group(0) @binding(7) var light: texture_2d<f32>;
@group(0) @binding(8) var mapSampler: sampler;
// r: the sun's visibility at the sea surface (maps.ts `shade`).
@group(0) @binding(9) var shade: texture_2d<f32>;
@group(0) @binding(10) var distance: texture_2d<f32>;
// b: where the swell breaks (maps.ts `flow`).
@group(0) @binding(11) var flow: texture_2d<f32>;
// a: how much of a drop-off the nearest coast is (maps.ts `paint`).
@group(0) @binding(12) var paint: texture_2d<f32>;
// The island owning each texel, its index + 1 (maps.ts `islands`); r the
// bank whose plate each sea texel stands on, its id + 1, and g, b, a every
// bank whose plate covers it, a bit per id (maps.ts `rings`).
@group(0) @binding(13) var islands: texture_2d<u32>;
@group(0) @binding(14) var rings: texture_2d<u32>;
@group(0) @binding(15) var<storage, read> selection: Selection;
@group(0) @binding(16) var<uniform> highlight: Highlight;
// Each bank's islands, by id, a bit per island index (the first 64).
@group(0) @binding(17) var<storage, read> members: array<vec2u>;
// The open sea's floor past the grid: r its height, g and b its normal's x
// and z (maps.ts `seabed`).
@group(0) @binding(18) var seabed: texture_2d<f32>;

// Distance for a ray that meets nothing: past the horizon.
const NOTHING = 1e9;
// The light map is read this far apart, uv, for the floor's convexity and
// the lip lines' width: a 1024 map's texel, whatever the resolution.
const RELIEF_SPAN = 1.0 / 1024.0;
// The open floor's relief fades from this many deep floors' depth to this,
// as it sinks past what the water shows.
const OPEN_SEEN = vec2f(1.2, 1.8);
// The swell meets a wall where the water has deepened this fast off the
// coast, depth a unit out: a beach shelves at a fraction, a drop-off at
// several.
const WALL_SLOPE = vec2f(0.8, 2.0);

fn skyAlong(direction: vec3f) -> vec3f {
  return sky(direction, water.horizon, water.zenith);
}

fn rayThrough(uv: vec2f) -> vec3f {
  let ndc = vec2f(uv.x * 2.0 - 1.0, 1.0 - uv.y * 2.0);
  return normalize(eye.forward + ndc.x * eye.apertureX * eye.right + ndc.y * eye.apertureY * eye.up);
}

fn filmTexel(uv: vec2f) -> vec2i {
  let size = vec2f(textureDimensions(filmDepth));
  return vec2i(clamp(uv * size, vec2f(0.0), size - 1.0));
}

// What the ray through `uv` meets under the water: the film's terrain, or
// past the mesh the open floor at −openDepth; NOTHING above the horizon.
struct Floor {
  distance: f32,
  // The film drew it: its colour is the film's, not the open floor's.
  drawn: bool,
}

fn floorAt(uv: vec2f, ray: vec3f) -> Floor {
  let depth = textureLoad(filmDepth, filmTexel(uv), 0);
  if (depth > 0.0) {
    return Floor((eye.near / depth) / max(dot(ray, eye.forward), 1e-4), true);
  }
  if (ray.y >= 0.0) {
    return Floor(NOTHING, false);
  }
  return Floor((eye.eye.y + water.openDepth) / -ray.y, false);
}

fn floorColor(uv: vec2f, floor: Floor) -> vec3f {
  if (floor.drawn) {
    return textureSampleLevel(film, filmSampler, uv, 0.0).rgb;
  }
  return water.floorColor;
}

fn mapUv(xz: vec2f) -> vec2f {
  return (xz - grid.origin) / (grid.texel * f32(grid.resolution));
}

// The seabed map at chart point `xz`.
fn seabedAt(xz: vec2f) -> vec4f {
  return textureSampleLevel(seabed, mapSampler, squareUv(xz, grid.seabedOrigin, grid.seabedSide), 0.0);
}

// How much of the far floor shows at map uv `uv` (frame.wgsl `farShare`),
// as the terrain fades into it toward the grid's edge.
fn farAt(uv: vec2f) -> f32 {
  let farTexel = grid.seabedSide / f32(textureDimensions(seabed).x);
  return farShare(uv, farTexel / (grid.texel * f32(grid.resolution)));
}

// The floor's light at map uv `uv`, as the light map holds it (x, y its
// normal's x and z, z the occlusion, w the sun): toward the grid's edge
// and past it, the seabed map's normal, open to the sky and in the sun, as
// the open deep is.
fn floorLightAt(uv: vec2f, xz: vec2f) -> vec4f {
  let share = select(farAt(uv), 1.0, pastSquare(uv));
  if (share <= 0.0) {
    return textureSampleLevel(light, mapSampler, uv, 0.0);
  }
  let s = seabedAt(xz);
  let far = vec4f(s.g, s.b, 1.0, 1.0);
  if (share >= 1.0) {
    return far;
  }
  return mix(textureSampleLevel(light, mapSampler, uv, 0.0), far, share);
}

// How far the open sea's floor has taken over at map uv `uv`, chart point
// `xz`: by how far past the platform's edge the height map's a has it,
// and toward the grid's edge and past it the seabed map's a, as the
// platform's fall runs on past the frame there.
fn openSeaAt(uv: vec2f, xz: vec2f) -> f32 {
  if (pastSquare(uv)) {
    return seabedAt(xz).a;
  }
  let bed = Bathymetry(water.floorDepth, water.slopeWidth, grid.texel);
  let near = openShareOf(bed, textureSampleLevel(height, mapSampler, uv, 0.0).a);
  let share = farAt(uv);
  if (share <= 0.0) {
    return near;
  }
  return mix(near, seabedAt(xz).a, share);
}

fn toUv(p: vec3f) -> vec2f {
  let clip = eye.viewProjection * vec4f(p, 1.0);
  let ndc = clip.xy / max(clip.w, 1e-6);
  return vec2f(ndc.x * 0.5 + 0.5, 0.5 - ndc.y * 0.5);
}

// Haze: by distance in eye heights, past the first, so a view straight
// down stays clear and every view fades the same way into its horizon,
// from the cool near haze to the warm far one, which is the sky's horizon.
fn hazed(color: vec3f, distance: f32) -> vec3f {
  let heights = max(distance / max(eye.eye.y, 1e-3) - 1.0, 0.0);
  let amount = 1.0 - exp(-water.haze * heights);
  return mix(color, mix(water.hazeNear, water.hazeFar, smoothstep(0.05, 0.7, amount)), amount);
}

// The light map's normal: x and z stored, y implied up.
fn mapNormal(l: vec4f) -> vec3f {
  return vec3f(l.x, sqrt(max(0.0, 1.0 - l.x * l.x - l.y * l.y)), l.y);
}

// The line at each sea step's lip under `uv` on the map: the floor's
// convexity and how fast its up changes, from the light map either side.
fn lipAt(uv: vec2f, footprint: f32) -> f32 {
  let east = textureSampleLevel(light, mapSampler, uv + vec2f(RELIEF_SPAN, 0.0), 0.0);
  let west = textureSampleLevel(light, mapSampler, uv - vec2f(RELIEF_SPAN, 0.0), 0.0);
  let south = textureSampleLevel(light, mapSampler, uv + vec2f(0.0, RELIEF_SPAN), 0.0);
  let north = textureSampleLevel(light, mapSampler, uv - vec2f(0.0, RELIEF_SPAN), 0.0);
  let up = mapNormal(textureSampleLevel(light, mapSampler, uv, 0.0)).y;
  let bend = 0.5 * (east.x - west.x + south.y - north.y);
  let across = 2.0 * RELIEF_SPAN * grid.texel * f32(grid.resolution);
  let slope = vec2f(mapNormal(east).y - mapNormal(west).y, mapNormal(south).y - mapNormal(north).y) / across;
  return lipLine(up, length(slope) * footprint, bend);
}

// About how far `uv` on the map lies off the water's edge, `depth` deep:
// the depth over the floor's slope.
fn edgeDistance(uv: vec2f, depth: f32) -> f32 {
  let side = grid.texel * f32(grid.resolution);
  let step = grid.texel / side;
  let east = textureSampleLevel(height, mapSampler, uv + vec2f(step, 0.0), 0.0).r;
  let west = textureSampleLevel(height, mapSampler, uv - vec2f(step, 0.0), 0.0).r;
  let south = textureSampleLevel(height, mapSampler, uv + vec2f(0.0, step), 0.0).r;
  let north = textureSampleLevel(height, mapSampler, uv - vec2f(0.0, step), 0.0).r;
  let slope = length(vec2f(east - west, south - north)) / (2.0 * grid.texel);
  return depth / max(slope, 1e-3);
}

// The ground the ray meets above the water, with the swash on a beach: the
// sand wet below the run-up and a thin sheet of water running up it and
// back, its edge laced with foam. The run-up follows the surf offshore
// (the flow map's breaking, the most of SWASH_TAPS around), so a lee beach
// only laps; a drop-off has none.
const SWASH_TAPS = 6u;
const SWASH_SPAN = 4.0;
const SWASH_CALM = 0.35;
// The sheet's tint: the shallowest band, this much of it over the sand.
const SHEET_TINT = 0.4;
const WET_SAND = vec3f(0.66, 0.64, 0.6);

fn swashed(uv: vec2f, ray: vec3f, under: Floor) -> vec3f {
  let ground = floorColor(uv, under);
  if (water.swash <= 0.0 || !under.drawn) {
    return ground;
  }
  let p = eye.eye + ray * under.distance;
  if (p.y > 2.0 * water.swashReach) {
    return ground;
  }
  let uvMap = mapUv(p.xz);
  let beach = 1.0 - textureSampleLevel(paint, mapSampler, uvMap, 0.0).a;
  if (beach <= 0.0) {
    return ground;
  }
  var breaking = 0.0;
  let span = SWASH_SPAN / (grid.texel * f32(grid.resolution));
  for (var i = 0u; i < SWASH_TAPS; i++) {
    let angle = 6.2831853 * f32(i) / f32(SWASH_TAPS);
    breaking = max(breaking, textureSampleLevel(flow, mapSampler, uvMap + span * vec2f(cos(angle), sin(angle)), 0.0).b);
  }
  let reach = water.swashReach * mix(SWASH_CALM, 1.0, saturate(breaking)) * beach;
  let pixel = under.distance * 2.0 * eye.apertureY / f32(textureDimensions(film).y);
  let s = swash(p.xz, p.y, reach, water.swashPeriod, eye.time, pixel / max(-ray.y, 0.05));
  let lit = waterLight(textureSampleLevel(shade, mapSampler, uvMap, 0.0).r, water.shadowAmbient);
  var color = mix(ground, ground * WET_SAND, s.wet * water.wetSand);
  color = mix(color, mix(color, water.bands[0].rgb * lit, SHEET_TINT), s.sheet * water.swash);
  return mix(color, FOAM * lit, saturate(s.lace * water.swash));
}

fn composite(uv: vec2f) -> vec3f {
  let ray = rayThrough(uv);
  let under = floorAt(uv, ray);
  if (water.enabled < 0.5) {
    if (!under.drawn) {
      return skyAlong(ray);
    }
    return textureSampleLevel(film, filmSampler, uv, 0.0).rgb;
  }
  if (under.distance >= NOTHING) {
    return skyAlong(ray);
  }
  // 1. The plane hit.
  let toPlane = select(-1.0, -eye.eye.y / ray.y, ray.y < 0.0);
  // 2. Terrain nearer than the plane, with the swash on a beach.
  if (toPlane < 0.0 || under.distance <= toPlane) {
    return hazed(swashed(uv, ray, under), under.distance);
  }
  let hit = eye.eye + ray * toPlane;
  // A pixel's width on the water, stretched along the ray at a grazing angle.
  let pixel = toPlane * 2.0 * eye.apertureY / f32(textureDimensions(film).y);
  let footprint = pixel / max(-ray.y, 0.05);
  let surface = waveSurface(hit.xz, footprint, eye.time, water.waveStrength, water.waves);
  let normal = surface.normal;

  // 3. Thickness, from the depth.
  var thickness = under.distance - toPlane;
  var below = floorColor(uv, under);
  // 4. Refraction, where there is a floor to refract.
  let moved = eye.eye + ray * under.distance + vec3f(normal.x, 0.0, normal.z) * min(thickness, water.refractionReach) * water.refraction;
  let movedUv = toUv(moved);
  let movedRay = rayThrough(movedUv);
  let movedFloor = floorAt(movedUv, movedRay);
  let movedPlane = select(-1.0, -eye.eye.y / movedRay.y, movedRay.y < 0.0);
  // Landing on terrain above the water would smear the coast into the sea.
  let underwater = movedPlane > 0.0 && movedFloor.distance > movedPlane && movedFloor.distance < NOTHING;
  if (underwater) {
    below = floorColor(movedUv, movedFloor);
    thickness = movedFloor.distance - movedPlane;
  }

  // 5. The floor's detail, under the water. Everything of the floor is
  // read where the eye sees it, through the waves: the refracted floor
  // point, so the waves bend the floor's colour, relief and lines alike.
  // The surface's own terms (its shadow, the shore) stay at the hit.
  let uvMap = mapUv(hit.xz);
  let depth = max(-textureSampleLevel(height, mapSampler, uvMap, 0.0).r, 0.0);
  let seen = select(eye.eye + ray * under.distance, eye.eye + movedRay * movedFloor.distance, underwater);
  let floorMap = mapUv(seen.xz);
  // Its depth from where it lies, not the height map: up a wall one texel
  // spans the whole fall, and would saw the legend into teeth.
  let seenDepth = max(-seen.y, 0.0);
  let floorLight = floorLightAt(floorMap, seen.xz);
  let sunlit = floorLight.w;
  if (water.seaLines > 0.0 && !pastSquare(floorMap)) {
    let lines = lipAt(floorMap, footprint) * water.seaLines * (1.0 - farAt(floorMap));
    below = mix(below, water.seaLine, lines);
  }
  let shallow = (1.0 - smoothstep(0.75 * water.top, 4.5 * water.top, seenDepth)) * smoothstep(0.05, 0.6, seenDepth);
  if (water.caustics > 0.0 && shallow > 0.0) {
    let focus = caustics(seen.xz, water.causticSize, eye.time, footprint);
    below += water.sunColor * focus * 0.5 * water.caustics * shallow * sunlit * water.sun.y;
  }

  // 6. Absorption and scatter, per channel. The floor in the film is
  // already in its own shadow; the water's colour takes the shadow at the
  // surface, which lies nearer the land by the depth times the sun's run.
  let lit = waterLight(textureSampleLevel(shade, mapSampler, uvMap, 0.0).r, water.shadowAmbient);
  let transmitted = transmittance(thickness, water.absorption, water.clarity, water.depthPower, water.depthCurve);
  let floorNormal = mapNormal(floorLight);
  // The deep calms the floor's relief, but for the open sea's, by as much
  // as the seascape relief lifts the calm, until the open floor sinks past
  // what the water shows and the sea is open water again.
  let sunk = 1.0 - smoothstep(OPEN_SEEN.x * water.floorDepth, OPEN_SEEN.y * water.floorDepth, seenDepth);
  let openSea = openSeaAt(floorMap, seen.xz);
  let openRelief = openSea * water.seascapeRelief * sunk;
  // Past it, none of the open floor's relief shows at all.
  let shown = 1.0 - openSea * (1.0 - sunk);
  let deep = smoothstep(0.5 * water.floorDepth, water.floorDepth, seenDepth) * (1.0 - openRelief);
  var scatter = mix(water.scatter, bandColor(water.bands, seenDepth), water.legend);
  scatter *= floorRelief(floorNormal, water.sun, sunlit, floorLight.z, deep, water.relief * shown);
  var color = below * transmitted + scatter * (1.0 - transmitted) * lit;
  color = rimmed(color, riserRim(floorNormal, water.sun, deep) * water.rim * shown);

  // 7. The shore: the beach's glow, and the surf.
  let coast = textureSampleLevel(distance, mapSampler, uvMap, 0.0).r;
  let steep = textureSampleLevel(paint, mapSampler, uvMap, 0.0).a;
  let surfaceSun = textureSampleLevel(light, mapSampler, uvMap, 0.0).w;
  let sand = shoal(color, depth, coast, water.shoalReach, water.top, steep, surfaceSun, water.shoalGlow);
  let breaking = textureSampleLevel(flow, mapSampler, uvMap, 0.0).b;
  let breakers = surf(hit.xz, coast, edgeDistance(uvMap, depth), breaking, water.surfSpacing, water.surfSpeed, eye.time, footprint) * water.surf;
  let wall = smoothstep(WALL_SLOPE.x, WALL_SLOPE.y, depth / max(coast, grid.texel));
  let wash = cliffWash(hit.xz, coast, wall, water.washWidth, water.washPeriod, eye.time, footprint) * water.wash;
  let foam = max(breakers, wash);
  color = mix(sand.color, FOAM * lit, saturate(foam));

  // 8. The sky, by Fresnel, in the same shadow.
  color = mix(color, skyAlong(reflect(ray, normal)) * lit, saturate(fresnel(ray, normal) * water.reflection));

  // 9. The sun's glint, in the light map's shadow.
  color += water.sunColor * glint(ray, surface, water.sun) * water.specular * surfaceSun;
  return hazed(color + sand.glow * (1.0 - saturate(foam)), toPlane);
}

// Whether a ring (its id + 1) covers a texel whose rings map reads r.
fn ringCovers(r: vec4u, ring: u32) -> f32 {
  if (ring == 0u) {
    return 0.0;
  }
  // Large charts: selection-resolve.wgsl's flags, bit 0 the chosen ring,
  // bit 1 the hovered.
  if (SCALABLE_SELECTION) {
    let bit = select(1u, 0u, ring == selection.ring);
    return f32((r.g >> bit) & 1u);
  }
  let id = ring - 1u;
  // A ring past the footprint's bits is chosen where it is on top.
  if (id >= RING_BITS) {
    return select(0.0, 1.0, r.r == ring);
  }
  return f32((r[1u + id / 16u] >> (id % 16u)) & 1u);
}

// How much of texel t is chosen and hovered, from one read of it: x, what
// the chosen's outline runs round, 1 on the island's land or the ring's
// plates; y, what lightens, x and `memberFill` on a chosen ring's islands'
// land; z, what the hovered's outline runs round. A map no one asks about
// is not read.
fn selectedAt(t: vec2i, members: vec2u) -> vec3f {
  let land = textureLoad(distance, t, 0).r < 0.0;
  if (land) {
    if (selection.island + selection.ring + selection.hoverIsland == 0u) {
      return vec3f(0.0);
    }
    let owner = textureLoad(islands, t, 0).r;
    if (owner == 0u) {
      return vec3f(0.0);
    }
    let index = owner - 1u;
    // Large charts: bit 2 of the resolved flags; small ones, the chosen
    // ring's two-word mask.
    var member = false;
    if (SCALABLE_SELECTION) {
      member = (textureLoad(rings, t, 0).g & 4u) != 0u;
    } else {
      member = index < 64u && ((members[index / 32u] >> (index % 32u)) & 1u) == 1u;
    }
    let own = select(0.0, 1.0, owner == selection.island);
    let hovered = select(0.0, 1.0, owner == selection.hoverIsland);
    return vec3f(own, max(own, select(0.0, highlight.memberFill, member)), hovered);
  }
  if (selection.ring + selection.hoverRing == 0u) {
    return vec3f(0.0);
  }
  let r = textureLoad(rings, t, 0);
  let chose = ringCovers(r, selection.ring);
  return vec3f(chose, chose, ringCovers(r, selection.hoverRing));
}

// The chosen and hovered shares at map uv, read bilinear over the four
// texels round it, so their edges run smooth between texels instead of
// stepping with them.
fn selectedNear(uvMap: vec2f, members: vec2u) -> vec3f {
  let size = vec2f(textureDimensions(rings));
  let at = uvMap * size - 0.5;
  let base = floor(at);
  let f = at - base;
  let last = vec2i(size) - 1;
  let t = clamp(vec2i(base), vec2i(0), last);
  let u = clamp(vec2i(base) + 1, vec2i(0), last);
  let a = selectedAt(t, members);
  let b = selectedAt(vec2i(u.x, t.y), members);
  let c = selectedAt(vec2i(t.x, u.y), members);
  let d = selectedAt(u, members);
  return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
}

// The banks the rings map's footprint holds (maps/height.wgsl).
const RING_BITS = 48u;
// The outline's half width and its glow's reach, pixels.
const OUTLINE_PIXELS = 1.25;
const GLOW_PIXELS = 7.0;
const GLOW = 0.35;
// A hovered outline's strength against a chosen one's.
const HOVER = 0.7;
// How far past the maps' square the dimming fades out, a share of its side.
const DIM_FADE = 0.3;

// A share's edge on screen at its half: the line, and a glow fading from it.
fn outlineOf(share: f32) -> f32 {
  let across = abs(share - 0.5) / max(fwidth(share), 1e-4);
  let line = 1.0 - smoothstep(OUTLINE_PIXELS, OUTLINE_PIXELS + 1.0, across);
  let glow = GLOW * (1.0 - smoothstep(0.0, GLOW_PIXELS, across));
  return max(line, glow);
}

// The selection over `color`: the ground the ray through uv meets, as the
// film drew it (under the water, its floor unrefracted).
fn selected(uv: vec2f, color: vec3f) -> vec3f {
  let shown = selection.island + selection.ring + selection.hoverIsland + selection.hoverRing;
  if (shown == 0u) {
    return color;
  }
  let ray = rayThrough(uv);
  let under = floorAt(uv, ray);
  let uvMap = mapUv((eye.eye + ray * min(under.distance, 1e6)).xz);
  let drawn = select(0.0, 1.0, under.drawn);
  var mask = vec2u(0u);
  if (!SCALABLE_SELECTION && selection.ring > 0u && selection.ring <= arrayLength(&members)) {
    mask = members[selection.ring - 1u];
  }
  // Off the maps' square, past the mesh or in the sky nothing is chosen:
  // no map is read there.
  var shares = vec3f(0.0);
  if (under.drawn && all(uvMap >= vec2f(0.0)) && all(uvMap <= vec2f(1.0))) {
    shares = selectedNear(uvMap, mask);
  }
  let inside = smoothstep(0.0, 1.0, shares.y);
  let line = max(outlineOf(shares.x), HOVER * outlineOf(shares.z)) * highlight.outline;
  // The rest of the chart dims, fading out past the maps' square so the
  // open sea meets the sky as it did; the chosen lightens toward the
  // colour, a screen.
  let past = length(max(abs(uvMap - 0.5) - 0.5, vec2f(0.0)));
  let onChart = drawn * (1.0 - smoothstep(0.0, DIM_FADE, past));
  let anyChosen = select(0.0, onChart, selection.island + selection.ring > 0u);
  let rest = color * (1.0 - highlight.dim * anyChosen * (1.0 - inside));
  let screen = 1.0 - (1.0 - saturate(color)) * (1.0 - highlight.color);
  let lifted = mix(rest, screen, inside * highlight.fill);
  return mix(lifted, highlight.color, saturate(line));
}

@fragment
fn fs_main(@location(0) uv: vec2f) -> @location(0) vec4f {
  return vec4f(max(selected(uv, composite(uv)), vec3f(0.0)), 1.0);
}

// The vertex an effect would supply, for drawing this as a `draw`, which
// takes the pipeline constants an effect can't: one triangle over the
// target, uv 0 at its top left.
struct FullscreenVertexOut {
  @builtin(position) position: vec4f,
  @location(0) uv: vec2f,
}

@vertex
fn vs_main(@builtin(vertex_index) vi: u32) -> FullscreenVertexOut {
  var pos = array<vec2f, 3>(vec2f(-1.0, -1.0), vec2f(3.0, -1.0), vec2f(-1.0, 3.0));
  var uv = array<vec2f, 3>(vec2f(0.0, 1.0), vec2f(2.0, 1.0), vec2f(0.0, -1.0));
  var out: FullscreenVertexOut;
  out.position = vec4f(pos[vi], 0.0, 1.0);
  out.uv = uv[vi];
  return out;
}
