// The paint map: colour without light. On land the owner's pastel cap (the
// terrain lays the cliff rock on its rim); off it the floor's colour (sea/
// floor.wgsl): sand on the beaches, silt and the bands below. Eased by
// coverage. Alpha: how much of a drop-off the nearest coast is, along the
// shore.
import { FloorPaint, floorPaint } from "../sea/floor.wgsl";
import { ease, MapFrame } from "./frame.wgsl";

struct PaintParams {
  frame: MapFrame,
  floor: FloorPaint,
  islandCount: u32,
  // sea/bathymetry.wgsl `shoreSteepness`'s depths, read `probe` offshore.
  sandDepth: f32,
  cliffDepth: f32,
  probe: f32,
}

@group(0) @binding(0) var<uniform> params: PaintParams;
@group(0) @binding(1) var islands: texture_2d<u32>;
@group(0) @binding(2) var coverage: texture_2d<f32>;
@group(0) @binding(3) var distance: texture_2d<f32>;
// Each island's cap colour, linear, by index.
@group(0) @binding(4) var<storage, read> colors: array<vec4f>;
@group(0) @binding(5) var paint: texture_storage_2d<rgba8unorm, write>;
@group(0) @binding(6) var height: texture_2d<f32>;

fn clamped(texel: vec2i) -> vec2i {
  let last = i32(params.frame.resolution) - 1;
  return clamp(texel, vec2i(0), vec2i(last));
}

fn distanceAt(texel: vec2i) -> f32 {
  return textureLoad(distance, clamped(texel), 0).r;
}

fn heightAt(texel: vec2i) -> f32 {
  return textureLoad(height, clamped(texel), 0).r;
}

// How much of a drop-off the nearest coast is: the depth `probe` off it.
fn steepness(texel: vec2i, d: f32) -> f32 {
  let grad = vec2f(
    distanceAt(texel + vec2i(1, 0)) - distanceAt(texel - vec2i(1, 0)),
    distanceAt(texel + vec2i(0, 1)) - distanceAt(texel - vec2i(0, 1)),
  );
  let away = grad / max(length(grad), 1e-6);
  let offshore = vec2f(texel) + away * (params.probe - d) / params.frame.texel;
  let depth = -heightAt(vec2i(round(offshore)));
  return ease(params.sandDepth, params.cliffDepth, depth);
}

@compute @workgroup_size(8, 8)
fn cs_main(@builtin(global_invocation_id) id: vec3u) {
  let n = params.frame.resolution;
  if (id.x >= n || id.y >= n) {
    return;
  }
  let texel = vec2i(id.xy);
  let owner = textureLoad(islands, id.xy, 0).r;
  let sea = floorPaint(params.floor, heightAt(texel));
  var land = sea;
  if (owner > 0u && owner <= params.islandCount) {
    land = colors[owner - 1u].rgb;
  }
  let color = mix(sea, land, textureLoad(coverage, id.xy, 0).r);
  let d = textureLoad(distance, id.xy, 0).r;
  var steep = 0.0;
  if (owner > 0u && abs(d) < params.probe) {
    steep = steepness(texel, d);
  }
  textureStore(paint, id.xy, vec4f(color, steep));
}
