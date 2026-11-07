// One mip level from the level above it: the mean of each 2×2 block. Map
// sides are powers of two, so every block is whole.

@group(0) @binding(0) var source: texture_2d<f32>;

@fragment
fn fs_main(@builtin(position) position: vec4f) -> @location(0) vec4f {
  let corner = vec2u(floor(position.xy)) * 2u;
  let sum = textureLoad(source, corner, 0)
    + textureLoad(source, corner + vec2u(1u, 0u), 0)
    + textureLoad(source, corner + vec2u(0u, 1u), 0)
    + textureLoad(source, corner + vec2u(1u, 1u), 0);
  return sum * 0.25;
}
