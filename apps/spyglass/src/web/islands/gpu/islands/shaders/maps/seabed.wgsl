// The seabed map: the sea's floor far past the frame over a square several
// frames across, coarser than the frame's maps. The terrain stands on it
// past the frame's edge, and the water lights the floor there by its
// normal.
// It is the height map's floor run on past the edge, by the same rules:
// the platform's fall (sea/bathymetry.wgsl `platformHeight`), then the open
// sea's floor (sea/seascape.wgsl) sinking what has come down to the deep
// floor. How far past the platform's edge p is comes from the height map's
// a at the frame's edge nearest p, run on by how much farther from the
// coasts p is than that edge (`openCoast`, from the distance map's coarse
// grid, which runs on past the frame). So where the platform's fall runs
// into the frame's margin, it carries on falling past the edge, ring by
// ring, as it would have in a larger frame, and the open floor takes over
// past it there just as it does inside.
// Across its outer band it eases onto the open depth, flat, the depth the
// water's open floor lies at past the mesh (map-uniforms.ts
// `openFloorDepth`), so the ground and the water meet there too.
//
// r: the floor's height, chart units, under sea level. g, b: its normal, x
// and z (y up, implied). a: how far the open sea's floor has taken over,
// 0–1 (bathymetry.wgsl `openShareOf`), as the water reads it past the
// frame.
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
  // The frame's maps' square, whose distance and height maps this reads.
  grid: MapFrame,
  seascape: Seascape,
  // The height map's bathymetry, its texel the frame's, so the platform's
  // fall lays out its escarpment and rings here as it does there.
  bed: Bathymetry,
  platform: Platform,
  banks: Banks,
  // The open depth the outer band eases onto, and the band's width, chart
  // units in from the square's edge.
  openDepth: f32,
  band: f32,
}

@group(0) @binding(0) var<uniform> params: SeabedParams;
// r: the signed distance to the nearest coast (maps.ts `distance`).
@group(0) @binding(1) var distance: texture_2d<f32>;
// a: how far past the platform's edge the floor is within the frame
// (maps.ts `height`).
@group(0) @binding(2) var height: texture_2d<f32>;
@group(0) @binding(3) var linear: sampler;

// Past the frame's edge, coasts run farther off by at most about this many
// of the platform's slopes than at the edge itself: an edge this far past
// the slope's end leaves the open floor wholly in charge past it.
const PAST_SLACK = 2.0;

// How far p is in from the square's outer band, 0 at its edge to 1 past
// the band: eased on each side and multiplied, so its corners round off
// with no crease along their diagonals.
fn inBand(p: vec2f) -> f32 {
  let side = params.frame.texel * f32(params.frame.resolution);
  let low = p - params.frame.origin;
  let high = vec2f(side) - low;
  let x = ease(0.0, params.band, low.x) * ease(0.0, params.band, high.x);
  let y = ease(0.0, params.band, low.y) * ease(0.0, params.band, high.y);
  return x * y;
}

// The frame's nearest edge texel's centre to p; p itself within the frame.
fn frameEdgeNear(p: vec2f) -> vec2f {
  let side = params.grid.texel * f32(params.grid.resolution);
  let half = 0.5 * params.grid.texel;
  return clamp(p, params.grid.origin + half, params.grid.origin + side - half);
}

// How far past the platform's edge the height map has the floor at `at`,
// a point within the frame.
fn pastWithin(at: vec2f) -> f32 {
  let side = params.grid.texel * f32(params.grid.resolution);
  return textureSampleLevel(height, linear, squareUv(at, params.grid.origin, side), 0.0).a;
}

// The floor at p, `past` the platform's edge, the coasts there as `coast`:
// the platform's fall, the open sea's floor sinking what has come down to
// the deep floor (as height.wgsl `seaFloor` does), then onto the open
// depth across the outer band.
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

// The floor `offset` from p: the coasts there, and how far past the
// platform's edge, run on from p's along their way out, as they change too
// slowly over a texel to read again.
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
  // How far past the platform's edge p is: the frame's edge's, run on by
  // how much farther from the coasts p lies. Where the edge is well past
  // the slope already, the open floor has it all, however far p is.
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
