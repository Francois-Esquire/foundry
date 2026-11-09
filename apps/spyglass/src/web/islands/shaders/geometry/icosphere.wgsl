// A unit icosphere generated from the vertex index, for instanced props
// drawn without a vertex buffer: level 0 is the icosahedron (20 faces),
// level 1 splits each face in four (80 faces). Triangles come as a list,
// three vertices each, wound counter-clockwise seen from outside.

// The golden ratio and the radius of (1, φ, 0), to put corners on the unit sphere.
const PHI = 1.618034;
const CORNER_RADIUS = 1.9021131;

const CORNERS = array<vec3f, 12>(
  vec3f(-1.0, PHI, 0.0), vec3f(1.0, PHI, 0.0), vec3f(-1.0, -PHI, 0.0), vec3f(1.0, -PHI, 0.0),
  vec3f(0.0, -1.0, PHI), vec3f(0.0, 1.0, PHI), vec3f(0.0, -1.0, -PHI), vec3f(0.0, 1.0, -PHI),
  vec3f(PHI, 0.0, -1.0), vec3f(PHI, 0.0, 1.0), vec3f(-PHI, 0.0, -1.0), vec3f(-PHI, 0.0, 1.0),
);

const FACES = array<vec3u, 20>(
  vec3u(0u, 11u, 5u), vec3u(0u, 5u, 1u), vec3u(0u, 1u, 7u), vec3u(0u, 7u, 10u), vec3u(0u, 10u, 11u),
  vec3u(1u, 5u, 9u), vec3u(5u, 11u, 4u), vec3u(11u, 10u, 2u), vec3u(10u, 7u, 6u), vec3u(7u, 1u, 8u),
  vec3u(3u, 9u, 4u), vec3u(3u, 4u, 2u), vec3u(3u, 2u, 6u), vec3u(3u, 6u, 8u), vec3u(3u, 8u, 9u),
  vec3u(4u, 9u, 5u), vec3u(2u, 4u, 11u), vec3u(6u, 2u, 10u), vec3u(8u, 6u, 7u), vec3u(9u, 8u, 1u),
);

// Vertices in the triangle list at each level.
export const ICOSPHERE_VERTICES_0 = 60u;
export const ICOSPHERE_VERTICES_1 = 240u;

fn corner(i: u32) -> vec3f {
  return CORNERS[i] / CORNER_RADIUS;
}

// One corner (0–2) of a triangle, on the unit sphere. Levels above 1 are
// treated as 1.
export fn icosphereCorner(triangle: u32, which: u32, level: u32) -> vec3f {
  if (level == 0u) {
    let face = FACES[triangle % 20u];
    return corner(face[which % 3u]);
  }
  let face = FACES[(triangle / 4u) % 20u];
  let a = corner(face.x);
  let b = corner(face.y);
  let c = corner(face.z);
  let ab = normalize(a + b);
  let bc = normalize(b + c);
  let ca = normalize(c + a);
  // The four children: three at the corners, one in the middle.
  var tri: array<vec3f, 3>;
  switch triangle % 4u {
    case 0u: { tri = array<vec3f, 3>(a, ab, ca); }
    case 1u: { tri = array<vec3f, 3>(ab, b, bc); }
    case 2u: { tri = array<vec3f, 3>(ca, bc, c); }
    default: { tri = array<vec3f, 3>(ab, bc, ca); }
  }
  return tri[which % 3u];
}
