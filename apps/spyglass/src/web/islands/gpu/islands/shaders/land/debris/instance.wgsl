// One prop as the placement writes it and the draws read it: three vec4f.
// Pure: place.wgsl and props.wgsl own the buffer.

export const INSTANCE_STRIDE = 3u;

export const PEBBLE = 0u;
export const SHELL = 1u;
export const STACK = 2u;

// The draws' arguments: four u32 each, the bodies and the stacks' rings.
export const ARGS_BODIES = 0u;
export const ARGS_RINGS = 4u;
export const RING_VERTICES = 6u;

export struct Instance {
  // Where it stands on the floor, and its radius, chart units.
  base: vec3f,
  radius: f32,
  // The floor's normal there, and its turn about its up, radians.
  ground: vec3f,
  turn: f32,
  kind: u32,
  // 0–1, for its colour and shape.
  variant: f32,
  // Its height over its radius: a stack's column, a pebble's squash.
  height: f32,
  // The water over the floor where it stands.
  depth: f32,
}

export fn packInstance(i: Instance) -> array<vec4f, 3> {
  return array<vec4f, 3>(
    vec4f(i.base, i.radius),
    vec4f(i.ground, i.turn),
    vec4f(f32(i.kind), i.variant, i.height, i.depth),
  );
}

export fn unpackInstance(a: vec4f, b: vec4f, c: vec4f) -> Instance {
  return Instance(a.xyz, a.w, b.xyz, b.w, u32(c.x + 0.5), c.y, c.z, c.w);
}
