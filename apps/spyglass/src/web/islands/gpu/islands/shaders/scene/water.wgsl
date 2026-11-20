
import { farShare, pastSquare, squareUv } from "../maps/frame.wgsl";
import { Bathymetry, openShareOf } from "../sea/bathymetry.wgsl";
import { bandColor } from "../sea/floor.wgsl";
import { cliffWash, FOAM, shoal, surf, swash } from "../sea/shore.wgsl";
import { caustics, floorRelief, fresnel, glint, lipLine, riserRim, rimmed, sky, transmittance, waterLight, waveSurface } from "../sea/surface.wgsl";

override SCALABLE_SELECTION: bool = false;

struct Eye {
  viewProjection: mat4x4f,
  eye: vec3f,
  near: f32,
  forward: vec3f,
  apertureX: f32,
  right: vec3f,
  apertureY: f32,
  up: vec3f,
  time: f32,
}

struct Grid {
  origin: vec2f,
  texel: f32,
  resolution: u32,
  seabedOrigin: vec2f,
  seabedSide: f32,
}

struct Water {
  absorption: vec3f,
  enabled: f32,
  clarity: f32,
  depthPower: f32,
  depthCurve: f32,
  shadowAmbient: f32,
  scatter: vec3f,
  reflection: f32,
  sun: vec3f,
  specular: f32,
  sunColor: vec3f,
  refraction: f32,
  horizon: vec3f,
  waveStrength: f32,
  zenith: vec3f,
  haze: f32,
  hazeNear: vec3f,
  seaLines: f32,
  hazeFar: vec3f,
  floorDepth: f32,
  floorColor: vec3f,
  top: f32,
  seaLine: vec3f,
  shoalGlow: f32,
  shoalReach: f32,
  surf: f32,
  surfSpacing: f32,
  surfSpeed: f32,
  caustics: f32,
  causticSize: f32,
  legend: f32,
  relief: f32,
  rim: f32,
  openDepth: f32,
  seascapeRelief: f32,
  refractionReach: f32,
  wash: f32,
  washWidth: f32,
  washPeriod: f32,
  swash: f32,
  swashReach: f32,
  swashPeriod: f32,
  wetSand: f32,
  slopeWidth: f32,
  bands: array<vec4f, 6>,
  waves: array<vec4f, 32>,
}

struct Selection {
  island: u32,
  ring: u32,
  hoverIsland: u32,
  hoverRing: u32,
}

struct Highlight {
  fill: f32,
  outline: f32,
  memberFill: f32,
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
@group(0) @binding(9) var shade: texture_2d<f32>;
@group(0) @binding(10) var distance: texture_2d<f32>;
@group(0) @binding(11) var flow: texture_2d<f32>;
@group(0) @binding(12) var paint: texture_2d<f32>;
@group(0) @binding(13) var islands: texture_2d<u32>;
@group(0) @binding(14) var rings: texture_2d<u32>;
@group(0) @binding(15) var<storage, read> selection: Selection;
@group(0) @binding(16) var<uniform> highlight: Highlight;
@group(0) @binding(17) var<storage, read> members: array<vec2u>;
@group(0) @binding(18) var seabed: texture_2d<f32>;

const NOTHING = 1e9;
const RELIEF_SPAN = 1.0 / 1024.0;
const OPEN_SEEN = vec2f(1.2, 1.8);
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

struct Floor {
  distance: f32,
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

fn seabedAt(xz: vec2f) -> vec4f {
  return textureSampleLevel(seabed, mapSampler, squareUv(xz, grid.seabedOrigin, grid.seabedSide), 0.0);
}

fn farAt(uv: vec2f) -> f32 {
  let farTexel = grid.seabedSide / f32(textureDimensions(seabed).x);
  return farShare(uv, farTexel / (grid.texel * f32(grid.resolution)));
}

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

fn hazed(color: vec3f, distance: f32) -> vec3f {
  let heights = max(distance / max(eye.eye.y, 1e-3) - 1.0, 0.0);
  let amount = 1.0 - exp(-water.haze * heights);
  return mix(color, mix(water.hazeNear, water.hazeFar, smoothstep(0.05, 0.7, amount)), amount);
}

fn mapNormal(l: vec4f) -> vec3f {
  return vec3f(l.x, sqrt(max(0.0, 1.0 - l.x * l.x - l.y * l.y)), l.y);
}

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

const SWASH_TAPS = 6u;
const SWASH_SPAN = 4.0;
const SWASH_CALM = 0.35;
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
  let toPlane = select(-1.0, -eye.eye.y / ray.y, ray.y < 0.0);
  if (toPlane < 0.0 || under.distance <= toPlane) {
    return hazed(swashed(uv, ray, under), under.distance);
  }
  let hit = eye.eye + ray * toPlane;
  let pixel = toPlane * 2.0 * eye.apertureY / f32(textureDimensions(film).y);
  let footprint = pixel / max(-ray.y, 0.05);
  let surface = waveSurface(hit.xz, footprint, eye.time, water.waveStrength, water.waves);
  let normal = surface.normal;

  var thickness = under.distance - toPlane;
  var below = floorColor(uv, under);
  let moved = eye.eye + ray * under.distance + vec3f(normal.x, 0.0, normal.z) * min(thickness, water.refractionReach) * water.refraction;
  let movedUv = toUv(moved);
  let movedRay = rayThrough(movedUv);
  let movedFloor = floorAt(movedUv, movedRay);
  let movedPlane = select(-1.0, -eye.eye.y / movedRay.y, movedRay.y < 0.0);
  let underwater = movedPlane > 0.0 && movedFloor.distance > movedPlane && movedFloor.distance < NOTHING;
  if (underwater) {
    below = floorColor(movedUv, movedFloor);
    thickness = movedFloor.distance - movedPlane;
  }

  let uvMap = mapUv(hit.xz);
  let depth = max(-textureSampleLevel(height, mapSampler, uvMap, 0.0).r, 0.0);
  let seen = select(eye.eye + ray * under.distance, eye.eye + movedRay * movedFloor.distance, underwater);
  let floorMap = mapUv(seen.xz);
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

  let lit = waterLight(textureSampleLevel(shade, mapSampler, uvMap, 0.0).r, water.shadowAmbient);
  let transmitted = transmittance(thickness, water.absorption, water.clarity, water.depthPower, water.depthCurve);
  let floorNormal = mapNormal(floorLight);
  let sunk = 1.0 - smoothstep(OPEN_SEEN.x * water.floorDepth, OPEN_SEEN.y * water.floorDepth, seenDepth);
  let openSea = openSeaAt(floorMap, seen.xz);
  let openRelief = openSea * water.seascapeRelief * sunk;
  let shown = 1.0 - openSea * (1.0 - sunk);
  let deep = smoothstep(0.5 * water.floorDepth, water.floorDepth, seenDepth) * (1.0 - openRelief);
  var scatter = mix(water.scatter, bandColor(water.bands, seenDepth), water.legend);
  scatter *= floorRelief(floorNormal, water.sun, sunlit, floorLight.z, deep, water.relief * shown);
  var color = below * transmitted + scatter * (1.0 - transmitted) * lit;
  color = rimmed(color, riserRim(floorNormal, water.sun, deep) * water.rim * shown);

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

  color = mix(color, skyAlong(reflect(ray, normal)) * lit, saturate(fresnel(ray, normal) * water.reflection));

  color += water.sunColor * glint(ray, surface, water.sun) * water.specular * surfaceSun;
  return hazed(color + sand.glow * (1.0 - saturate(foam)), toPlane);
}

fn ringCovers(r: vec4u, ring: u32) -> f32 {
  if (ring == 0u) {
    return 0.0;
  }
  if (SCALABLE_SELECTION) {
    let bit = select(1u, 0u, ring == selection.ring);
    return f32((r.g >> bit) & 1u);
  }
  let id = ring - 1u;
  if (id >= RING_BITS) {
    return select(0.0, 1.0, r.r == ring);
  }
  return f32((r[1u + id / 16u] >> (id % 16u)) & 1u);
}

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

// Match maps/bake-layout.ts and maps/height.wgsl.
const RING_BITS = 48u;
const OUTLINE_PIXELS = 1.25;
const GLOW_PIXELS = 7.0;
const GLOW = 0.35;
const HOVER = 0.7;
const DIM_FADE = 0.3;

fn outlineOf(share: f32) -> f32 {
  let across = abs(share - 0.5) / max(fwidth(share), 1e-4);
  let line = 1.0 - smoothstep(OUTLINE_PIXELS, OUTLINE_PIXELS + 1.0, across);
  let glow = GLOW * (1.0 - smoothstep(0.0, GLOW_PIXELS, across));
  return max(line, glow);
}

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
  var shares = vec3f(0.0);
  if (under.drawn && all(uvMap >= vec2f(0.0)) && all(uvMap <= vec2f(1.0))) {
    shares = selectedNear(uvMap, mask);
  }
  let inside = smoothstep(0.0, 1.0, shares.y);
  let line = max(outlineOf(shares.x), HOVER * outlineOf(shares.z)) * highlight.outline;
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
