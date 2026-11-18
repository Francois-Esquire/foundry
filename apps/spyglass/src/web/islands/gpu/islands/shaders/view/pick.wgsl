
struct Pick {
  eye: vec3f,
  near: f32,
  forward: vec3f,
  apertureX: f32,
  right: vec3f,
  apertureY: f32,
  up: vec3f,
  mode: u32,
  uv: vec2f,
  origin: vec2f,
  texel: f32,
  resolution: u32,
}

struct Selection {
  island: u32,
  ring: u32,
  hoverIsland: u32,
  hoverRing: u32,
  chosenAt: vec2f,
  pad: vec2f,
}

const CHOOSE = 1u;

@group(0) @binding(0) var<uniform> pick: Pick;
@group(0) @binding(1) var filmDepth: texture_depth_2d;
@group(0) @binding(2) var distance: texture_2d<f32>;
@group(0) @binding(3) var islands: texture_2d<u32>;
@group(0) @binding(4) var rings: texture_2d<u32>;
@group(0) @binding(5) var<storage, read_write> selection: Selection;

struct Under {
  found: vec2u,
  at: vec2f,
}

fn under() -> Under {
  let size = vec2f(textureDimensions(filmDepth));
  let depth = textureLoad(filmDepth, vec2i(clamp(pick.uv * size, vec2f(0.0), size - 1.0)), 0);
  if (depth <= 0.0) {
    return Under(vec2u(0u), vec2f(0.0));
  }
  let ndc = vec2f(pick.uv.x * 2.0 - 1.0, 1.0 - pick.uv.y * 2.0);
  let ray = normalize(pick.forward + ndc.x * pick.apertureX * pick.right + ndc.y * pick.apertureY * pick.up);
  let ground = pick.eye + ray * (pick.near / depth) / max(dot(ray, pick.forward), 1e-4);
  let n = f32(pick.resolution);
  let t = vec2i(clamp((ground.xz - pick.origin) / pick.texel, vec2f(0.0), vec2f(n - 1.0)));
  if (textureLoad(distance, t, 0).r < 0.0) {
    return Under(vec2u(textureLoad(islands, t, 0).r, 0u), ground.xz);
  }
  return Under(vec2u(0u, textureLoad(rings, t, 0).r), ground.xz);
}

@compute @workgroup_size(1)
fn main() {
  switch pick.mode {
    case 2u: {
      selection.island = 0u;
      selection.ring = 0u;
    }
    case 3u: {
      selection.hoverIsland = 0u;
      selection.hoverRing = 0u;
    }
    default: {
      let here = under();
      selection.hoverIsland = here.found.x;
      selection.hoverRing = here.found.y;
      if (pick.mode == CHOOSE) {
        selection.island = here.found.x;
        selection.ring = here.found.y;
        selection.chosenAt = here.at;
      }
    }
  }
}
