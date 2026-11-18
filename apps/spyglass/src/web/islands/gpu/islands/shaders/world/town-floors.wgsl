struct FloorParams {
  origin: vec2f,
  side: f32,
  count: u32,
}

@group(0) @binding(0) var<uniform> params: FloorParams;
@group(0) @binding(1) var<storage, read> sites: array<vec4f>;
@group(0) @binding(2) var height: texture_2d<f32>;
@group(0) @binding(3) var light: texture_2d<f32>;
@group(0) @binding(4) var linear: sampler;
@group(0) @binding(5) var<storage, read_write> floors: array<vec4f>;

const SAMPLES = 5u;
const SINK = 0.15;

fn groundAt(xz: vec2f) -> f32 {
  return textureSampleLevel(height, linear, (xz - params.origin) / params.side, 0.0).r;
}

@compute @workgroup_size(64)
fn cs_floors(@builtin(global_invocation_id) id: vec3u) {
  if (id.x >= params.count) {
    return;
  }
  let a = sites[id.x * 2u];
  let half = sites[id.x * 2u + 1u].xy;
  let c = cos(a.z);
  let s = sin(a.z);
  let middle = groundAt(a.xy);
  var low = middle;
  for (var i = 0u; i < SAMPLES; i++) {
    for (var j = 0u; j < SAMPLES; j++) {
      let t = vec2f(f32(i), f32(j)) / f32(SAMPLES - 1u) * 2.0 - 1.0;
      let local = t * half;
      let p = a.xy + vec2f(c * local.x - s * local.y, s * local.x + c * local.y);
      low = min(low, groundAt(p));
    }
  }
  let l = textureSampleLevel(light, linear, (a.xy - params.origin) / params.side, 0.0);
  floors[id.x] = vec4f(middle, middle - low + SINK, l.z, l.w);
}
