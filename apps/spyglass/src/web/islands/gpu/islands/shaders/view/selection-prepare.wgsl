
struct Params {
  resolution: u32,
  force: u32,
}

@group(0) @binding(0) var<uniform> params: Params;
@group(0) @binding(1) var<storage, read> selection: vec4u;
@group(0) @binding(2) var<storage, read_write> previous: vec4u;
@group(0) @binding(3) var<storage, read_write> args: array<u32>;

const GROUP = 8u;

@compute @workgroup_size(1)
fn main() {
  let changed = params.force != 0u || any(selection != previous);
  let groups = select(0u, (params.resolution + GROUP - 1u) / GROUP, changed);
  args[0] = groups;
  args[1] = groups;
  args[2] = 1u;
  previous = selection;
}
