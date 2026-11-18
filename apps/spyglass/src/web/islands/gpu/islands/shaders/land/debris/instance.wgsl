
export const INSTANCE_STRIDE = 3u;

export const PEBBLE = 0u;
export const SHELL = 1u;
export const STACK = 2u;

export const ARGS_BODIES = 0u;
export const ARGS_RINGS = 4u;
export const RING_VERTICES = 6u;

export struct Instance {
  base: vec3f,
  radius: f32,
  ground: vec3f,
  turn: f32,
  kind: u32,
  variant: f32,
  height: f32,
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
