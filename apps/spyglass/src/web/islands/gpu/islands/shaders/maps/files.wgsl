// The files map: every module of the chart as a disc at its place on its
// island, drawn instanced into the map, one quad per module. rgb is the
// file's colour by kind, premultiplied; a its cover, anti-aliased across a
// texel. Discs blend over each other where files crowd.
import { MapFrame } from "./frame.wgsl";

struct FilesParams {
  frame: MapFrame,
  // A disc's radius, chart units; frequently changed files' are larger.
  radius: f32,
}

// One module (map-data.ts `packModules`): its chart place, its kind's code,
// and 1 when it changes frequently.
struct File {
  at: vec2f,
  kind: f32,
  frequent: f32,
}

@group(0) @binding(0) var<uniform> params: FilesParams;
@group(0) @binding(1) var<storage, read> files: array<File>;

// How much larger a frequently changed file's disc is.
const FREQUENT_SCALE = 1.6;

// Colours by kind (map-data.ts `MODULE_KIND_CODES`), linear: source warm,
// tests cool, stories violet, the rest grey.
const SOURCE = vec3f(0.95, 0.55, 0.12);
const TEST = vec3f(0.1, 0.6, 0.75);
const STORY = vec3f(0.55, 0.3, 0.8);
const OTHER = vec3f(0.45);
// Frequently changed files, whatever their kind.
const FREQUENT = vec3f(0.9, 0.12, 0.1);

struct DiscOut {
  @builtin(position) position: vec4f,
  // Chart units from the disc's centre.
  @location(0) local: vec2f,
  @location(1) @interpolate(flat) color: vec3f,
  @location(2) @interpolate(flat) radius: f32,
}

fn kindColor(kind: u32) -> vec3f {
  switch kind {
    case 0u: {
      return SOURCE;
    }
    case 1u: {
      return TEST;
    }
    case 2u: {
      return STORY;
    }
    default: {
      return OTHER;
    }
  }
}

@vertex
fn vs_main(
  @builtin(vertex_index) vertex: u32,
  @builtin(instance_index) instance: u32,
) -> DiscOut {
  // Two triangles over the unit square, -1 to 1.
  var corners = array<vec2f, 6>(
    vec2f(-1.0, -1.0), vec2f(1.0, -1.0), vec2f(-1.0, 1.0),
    vec2f(-1.0, 1.0), vec2f(1.0, -1.0), vec2f(1.0, 1.0),
  );
  let file = files[instance];
  let frequent = file.frequent > 0.5;
  let radius = params.radius * select(1.0, FREQUENT_SCALE, frequent);
  // A texel past the disc, for its anti-aliased edge.
  let local = corners[vertex] * (radius + params.frame.texel);
  let side = params.frame.texel * f32(params.frame.resolution);
  let uv = (file.at + local - params.frame.origin) / side;
  var out: DiscOut;
  // Map row 0 is the frame's origin, chart y down: clip y runs the other way.
  out.position = vec4f(uv.x * 2.0 - 1.0, 1.0 - uv.y * 2.0, 0.0, 1.0);
  out.local = local;
  out.color = select(kindColor(u32(file.kind)), FREQUENT, frequent);
  out.radius = radius;
  return out;
}

@fragment
fn fs_main(in: DiscOut) -> @location(0) vec4f {
  let half = 0.5 * params.frame.texel;
  let cover = 1.0 - smoothstep(in.radius - half, in.radius + half, length(in.local));
  return vec4f(in.color * cover, cover);
}
