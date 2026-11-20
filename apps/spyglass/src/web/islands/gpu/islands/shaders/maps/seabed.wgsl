import {
  Banks,
  Bathymetry,
  deepShareOf,
  openShareOf,
  openWhole,
  Platform,
  platformHeight,
  platformUndulation,
} from "../sea/bathymetry.wgsl";
import { Coast, openCoast, Seascape, seascapeSink, sunkGround } from "../sea/seascape.wgsl";
import { ease, MapFrame, squareUv, texelCenter } from "./frame.wgsl";

struct SeabedParams {
  frame: MapFrame,
  grid: MapFrame,
  seascape: Seascape,
  bed: Bathymetry,
  platform: Platform,
  banks: Banks,
  openDepth: f32,
  band: f32,
}

@group(0) @binding(0) var<uniform> params: SeabedParams;
@group(0) @binding(1) var distance: texture_2d<f32>;
@group(0) @binding(2) var height: texture_2d<f32>;
@group(0) @binding(3) var linear: sampler;

const PAST_SLACK = 2.0;

fn inBand(p: vec2f) -> f32 {
  let side = params.frame.texel * f32(params.frame.resolution);
  let low = p - params.frame.origin;
  let high = vec2f(side) - low;
  let x = ease(0.0, params.band, low.x) * ease(0.0, params.band, high.x);
  let y = ease(0.0, params.band, low.y) * ease(0.0, params.band, high.y);
  return x * y;
}

fn frameEdgeNear(p: vec2f) -> vec2f {
  let side = params.grid.texel * f32(params.grid.resolution);
  let half = 0.5 * params.grid.texel;
  return clamp(p, params.grid.origin + half, params.grid.origin + side - half);
}

fn pastWithin(at: vec2f) -> f32 {
  let side = params.grid.texel * f32(params.grid.resolution);
  return textureSampleLevel(height, linear, squareUv(at, params.grid.origin, side), 0.0).a;
}

fn floorAt(p: vec2f, coast: Coast, past: f32) -> f32 {
  let bed = params.bed;
  let platform = params.platform;
  let base = platformHeight(bed, platform, params.banks, p, past);
  let onTop = 1.0 - ease(0.0, params.banks.step, -platform.base - base);
  var ground = base + platformUndulation(params.banks, p) * onTop;
  let share = openShareOf(bed, past) * deepShareOf(bed, ground);
  if (share > 0.0) {
    let sink = share * seascapeSink(params.seascape, p, coast.distance, coast.fall);
    ground = sunkGround(params.seascape, ground, sink, bed.floorDepth);
  }
  return mix(-params.openDepth, ground, inBand(p));
}

fn floorNear(p: vec2f, coast: Coast, past: f32, offset: vec2f) -> f32 {
  let further = dot(coast.fall, offset);
  let moved = Coast(coast.distance + further, coast.fall);
  return floorAt(p + offset, moved, past + further);
}

@fragment
fn fs_main(@builtin(position) position: vec4f) -> @location(0) vec4f {
  let p = texelCenter(params.frame, vec2u(floor(position.xy)));
  let step = params.frame.texel;
  let coast = openCoast(distance, params.grid, params.seascape, p);
  let edge = frameEdgeNear(p);
  var past = pastWithin(edge);
  let wholly = past > openWhole(params.bed) + PAST_SLACK * params.bed.slopeWidth;
  if (!wholly && any(edge != p)) {
    past += coast.distance - openCoast(distance, params.grid, params.seascape, edge).distance;
  }
  let h = floorAt(p, coast, past);
  let east = floorNear(p, coast, past, vec2f(step, 0.0));
  let west = floorNear(p, coast, past, vec2f(-step, 0.0));
  let south = floorNear(p, coast, past, vec2f(0.0, step));
  let north = floorNear(p, coast, past, vec2f(0.0, -step));
  let slope = vec2f(east - west, south - north);
  let normal = normalize(vec3f(-slope.x, 2.0 * step, -slope.y));
  return vec4f(h, normal.x, normal.z, openShareOf(params.bed, past));
}
