
struct Params {
  wordsPerBank: u32,
}

@group(0) @binding(0) var<uniform> params: Params;
@group(0) @binding(1) var<storage, read> selection: vec4u;
@group(0) @binding(2) var<storage, read> members: array<u32>;
@group(0) @binding(3) var footprints: texture_2d_array<u32>;
@group(0) @binding(4) var islands: texture_2d<u32>;
@group(0) @binding(5) var output: texture_storage_2d<rgba16uint, write>;

// Match maps/bake-layout.ts and maps/height.wgsl.
const BANKS_PER_PAGE = 128u;

fn covers(at: vec2u, bank: u32) -> u32 {
  if (bank == 0u) {
    return 0u;
  }
  let id = bank - 1u;
  let page = id / BANKS_PER_PAGE;
  if (page >= textureNumLayers(footprints)) {
    return 0u;
  }
  let bits = textureLoad(footprints, at, i32(page), 0);
  return (bits[(id % BANKS_PER_PAGE) / 32u] >> (id % 32u)) & 1u;
}

@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) id: vec3u) {
  if (any(id.xy >= textureDimensions(output))) {
    return;
  }
  let owner = textureLoad(islands, id.xy, 0).r;
  var member = 0u;
  if (owner > 0u && selection.y > 0u) {
    let word = (selection.y - 1u) * params.wordsPerBank + (owner - 1u) / 32u;
    if (word < arrayLength(&members)) {
      member = (members[word] >> ((owner - 1u) % 32u)) & 1u;
    }
  }
  let flags = covers(id.xy, selection.y) | (covers(id.xy, selection.w) << 1u) | (member << 2u);
  textureStore(output, id.xy, vec4u(0u, flags, 0u, 0u));
}
