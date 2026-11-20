
diagnostic(off, derivative_uniformity);

import { grassColor, grassSheen, grassTilt, grassWind } from "./grass.wgsl";
import { Land, landHeight } from "./land.wgsl";
import { farShare, pastSquare, squareUv } from "../maps/frame.wgsl";
import { FloorPaint, floorPaint } from "../sea/floor.wgsl";
import { sandRipples, specks } from "../sea/sand.wgsl";
import { flowKey, mapRamp, ringKey } from "./views.wgsl";

struct Camera {
  viewProjection: mat4x4f,
  eye: vec3f,
  time: f32,
}

struct Clip {
  origin: vec2i,
  stride: i32,
  cells: u32,
}

struct Grid {
  origin: vec2f,
  texel: f32,
  resolution: u32,
  view: u32,
  ramp: vec3f,
  flowSpeed: f32,
  land: Land,
  seabedOrigin: vec2f,
  seabedSide: f32,
  floor: FloorPaint,
}

struct Look {
  sun: vec3f,
  sunStrength: f32,
  sunColor: vec3f,
  skyStrength: f32,
  skyColor: vec3f,
  softLight: f32,
  seaFill: vec3f,
  shadowStrength: f32,
  rock: vec3f,
  rockTint: f32,
  bounce: vec3f,
  bounceStrength: f32,
  ripples: f32,
  rippleSpacing: f32,
  specks: f32,
  speckSize: f32,
  speck: vec3f,
  speckDensity: f32,
  top: f32,
  occlusion: f32,
  occlusionSun: f32,
  files: f32,
  grassLush: vec3f,
  grass: f32,
  grassDry: vec3f,
  grassSheen: f32,
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
@group(0) @binding(11) var<storage, read> islandColors: array<vec4f>;
@group(0) @binding(12) var flow: texture_2d<f32>;
@group(0) @binding(13) var shade: texture_2d<f32>;
@group(0) @binding(14) var rings: texture_2d<u32>;
@group(0) @binding(15) var files: texture_2d<f32>;
@group(0) @binding(16) var zoning: texture_2d<f32>;
@group(0) @binding(17) var seabed: texture_2d<f32>;

struct VertexOut {
  @builtin(position) position: vec4f,
  @location(0) world: vec3f,
}

const SUBTEXELS = 4.0;

fn latticeTexel(t: vec2i) -> vec2f {
  return vec2f(t) / SUBTEXELS;
}

fn chartAt(uv: vec2f) -> vec2f {
  return grid.origin + uv * grid.texel * f32(grid.resolution);
}

fn seabedAt(xz: vec2f) -> vec4f {
  return textureSampleLevel(seabed, mapSampler, squareUv(xz, grid.seabedOrigin, grid.seabedSide), 0.0);
}

fn farAt(uv: vec2f) -> f32 {
  let farTexel = grid.seabedSide / f32(textureDimensions(seabed).x);
  return farShare(uv, farTexel / (grid.texel * f32(grid.resolution)));
}

fn surfaceHeight(uv: vec2f) -> f32 {
  if (pastSquare(uv)) {
    return seabedAt(chartAt(uv)).r;
  }
  let h = textureSampleLevel(height, mapSampler, uv, 0.0);
  let near = landHeight(grid.land, h.g, h.b);
  let far = farAt(uv);
  if (far <= 0.0) {
    return near;
  }
  return mix(near, seabedAt(chartAt(uv)).r, far);
}

fn latticeHeight(t: vec2i) -> f32 {
  return surfaceHeight((latticeTexel(t) + 0.5) / f32(grid.resolution));
}

struct Level {
  corner: vec2i,
  stride: i32,
}

fn levelOf(level: u32) -> Level {
  let n = i32(clip.cells);
  let back = (n / 2) * clip.stride * ((1 << level) - 1);
  return Level(clip.origin - vec2i(back), clip.stride << level);
}

const SNAP_GRADIENT = 0.5;
const SNAP_REACH = 0.75;

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
  let along = select(vec2f(0.0), select(vec2f(1.0, 0.0), vec2f(0.0, 1.0), edge.x), any(edge));
  let alongX = outer.y && (g.x & 1) == 1;
  let alongY = outer.x && (g.y & 1) == 1;
  if (alongX || alongY) {
    let step = select(vec2i(0, 1), vec2i(1, 0), alongX);
    return 0.5 * (cornerAt(l, g - step, stride, along) + cornerAt(l, g + step, stride, along));
  }
  return cornerAt(l, g, stride, along);
}

fn cornerAt(l: Level, g: vec2i, stride: i32, along: vec2f) -> vec3f {
  let moved = snapped(latticeTexel(l.corner + g * l.stride), f32(stride) / SUBTEXELS, along);
  return vec3f(moved, surfaceHeight((moved + 0.5) / f32(grid.resolution)));
}

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

fn mapNormal(l: vec4f) -> vec3f {
  return vec3f(l.x, sqrt(max(0.0, 1.0 - l.x * l.x - l.y * l.y)), l.y);
}

fn softFacing(normal: vec3f) -> f32 {
  let wrap = look.softLight * smoothstep(0.72, 0.95, normal.y);
  let rise = max(look.sun.y, 0.05);
  return max((dot(normal, look.sun) + wrap) / (rise + wrap) * rise, 0.0);
}

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

const COAST_REACH = 1.5;

const WALL_UP = vec2f(0.6, 0.3);

fn landCover(inland: f32, y: f32, up: f32) -> f32 {
  let across = smoothstep(-0.5, 0.5, inland / max(fwidth(inland), 1e-4));
  let above = smoothstep(-0.5, 0.5, y / max(fwidth(y), 1e-4));
  return mix(across, above, smoothstep(WALL_UP.x, WALL_UP.y, up));
}

fn coastPaint(uv: vec2f, ground: Ground, cover: f32) -> vec3f {
  let reach = ground.inland * COAST_REACH / f32(grid.resolution);
  let land = textureSampleLevel(paint, mapSampler, uv + reach, 0.0).rgb;
  let sea = textureSampleLevel(paint, mapSampler, uv - reach, 0.0).rgb;
  return mix(sea, land, cover);
}

const CLIFF_UP = vec2f(0.86, 0.62);

fn luma(c: vec3f) -> f32 {
  return dot(c, vec3f(0.2126, 0.7152, 0.0722));
}

fn withRock(top: vec3f, cap: vec3f, normal: vec3f, cover: f32) -> vec3f {
  let hue = cap / max(luma(cap), 1e-3);
  let rock = look.rock * mix(vec3f(1.0), hue, look.rockTint);
  let cliff = smoothstep(CLIFF_UP.x, CLIFF_UP.y, normal.y) * cover;
  return mix(top, rock, cliff);
}

const BOUNCE_REACH = 6.0;
const BOUNCE_LEVEL = vec2f(1.0, 4.0);

fn bounceLight(uv: vec2f, normal: vec3f) -> vec3f {
  let out = normal.xz / max(length(normal.xz), 1e-3);
  let front = uv + out * BOUNCE_REACH / f32(grid.resolution);
  let level = 1.0 - smoothstep(BOUNCE_LEVEL.x, BOUNCE_LEVEL.y, abs(surfaceHeight(front)));
  let lit = textureSampleLevel(light, mapSampler, front, 0.0).w;
  let facing = saturate(0.65 - 0.6 * normal.y);
  return look.bounce * look.bounceStrength * level * mix(0.35, 1.0, lit) * facing;
}

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

fn withFiles(base: vec3f, uv: vec2f) -> vec3f {
  if (look.files <= 0.0) {
    return base;
  }
  let f = textureSampleLevel(files, mapSampler, uv, 0.0);
  return mix(base, f.rgb / max(f.a, 1e-4), f.a * look.files);
}

const SOIL = vec3f(0.11, 0.065, 0.035);
const PACKED_EARTH = vec3f(0.2, 0.17, 0.13);
const TURF_UP = vec2f(0.8, 0.92);
const SOIL_UP = vec2f(0.66, 0.8);
const HUMMOCK_TILT = 0.14;
const WIND_TILT = 0.4;

fn turfCover(inland: f32, normal: vec3f, cover: f32) -> f32 {
  return look.grass * cover * smoothstep(0.0, grid.land.rimWidth, inland) * smoothstep(TURF_UP.x, TURF_UP.y, normal.y);
}

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

fn openFloorShaded(p: vec3f) -> vec3f {
  let s = seabedAt(p.xz);
  let normal = vec3f(s.g, sqrt(max(0.0, 1.0 - s.g * s.g - s.b * s.b)), s.b);
  let base = floorPaint(grid.floor, p.y);
  let fill = mix(look.seaFill, look.skyColor, normal.y * 0.5 + 0.5) * look.skyStrength;
  let direct = look.sunColor * softFacing(normal) * look.sunStrength;
  return base * (fill + direct);
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
      var h = textureLoad(height, vec2i(clamp(uv * f32(grid.resolution), vec2f(0.0), vec2f(f32(grid.resolution) - 1.0))), 0).r;
      if (pastSquare(uv)) {
        h = seabedAt(chartAt(uv)).r;
      }
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
      let d = textureSampleLevel(distance, mapSampler, uv, 0.0).r;
      let sun = textureSampleLevel(shade, mapSampler, uv, 0.0).r;
      color = select(vec3f(0.15 + 0.8 * sun), vec3f(0.3, 0.2, 0.12), d < 0.0);
    }
    case 10u: {
      let f = textureSampleLevel(files, mapSampler, uv, 0.0);
      let ground = textureSampleLevel(paint, mapSampler, uv, 0.0).rgb * 0.4;
      color = f.rgb + ground * (1.0 - f.a);
    }
    case 11u: {
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
    if (pastSquare(uv)) {
      return vec4f(openFloorShaded(in.world), 1.0);
    }
    let near = shaded(uv, in.world, length(fwidth(in.world.xz)));
    let far = farAt(uv);
    if (far <= 0.0) {
      return vec4f(near, 1.0);
    }
    return vec4f(mix(near, openFloorShaded(in.world), far), 1.0);
  }
  return vec4f(debugView(uv, fw), 1.0);
}
