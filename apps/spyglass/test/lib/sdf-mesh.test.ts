import { describe, expect, it } from "vitest";
import {
  meshSdf,
  type SdfField,
  type SdfLattice,
  type SdfMeshChunk,
  type SdfMeshMethod,
  solveQef,
} from "../../src/lib/visualization/sdf-mesh";

const sphere: SdfField = {
  distance: (x, y, z) => Math.hypot(x, y, z) - 1,
};

/** A box of half sides 0.8, 0.6, 0.5, turned a little so no face lies on the lattice. */
const box: SdfField = {
  distance: (px, py, pz) => {
    const angle = 0.3;
    const x = px * Math.cos(angle) - py * Math.sin(angle);
    const y = px * Math.sin(angle) + py * Math.cos(angle);
    const qx = Math.abs(x) - 0.8;
    const qy = Math.abs(y) - 0.6;
    const qz = Math.abs(pz) - 0.5;
    return (
      Math.hypot(Math.max(qx, 0), Math.max(qy, 0), Math.max(qz, 0)) +
      Math.min(Math.max(qx, qy, qz), 0)
    );
  },
};

const torus: SdfField = {
  distance: (x, y, z) => Math.hypot(Math.hypot(x, y) - 0.8, z) - 0.3,
};

function lattice(spacing: number, half = 1.5): SdfLattice {
  const size = Math.round((2 * half) / spacing) + 1;
  // Offset a hair so no sample lies exactly on a symmetric surface.
  return {
    origin: [-half + 0.0137, -half + 0.0071, -half + 0.0093],
    size: [size, size, size],
    spacing,
  };
}

/** All chunks as one mesh, vertices merged by exact position. */
function merged(chunks: readonly SdfMeshChunk[]) {
  const ids = new Map<string, number>();
  const positions: number[] = [];
  const triangles: number[] = [];
  for (const chunk of chunks) {
    const local: number[] = [];
    for (let index = 0; index < chunk.positions.length / 3; index += 1) {
      const key = [
        chunk.positions[index * 3],
        chunk.positions[index * 3 + 1],
        chunk.positions[index * 3 + 2],
      ].join(",");
      let id = ids.get(key);
      if (id === undefined) {
        id = positions.length / 3;
        ids.set(key, id);
        positions.push(
          chunk.positions[index * 3] ?? 0,
          chunk.positions[index * 3 + 1] ?? 0,
          chunk.positions[index * 3 + 2] ?? 0
        );
      }
      local.push(id);
    }
    for (const index of chunk.indices) {
      triangles.push(local[index] ?? -1);
    }
  }
  return { positions, triangles };
}

/** Each undirected edge's count of triangles, and whether every directed edge appears once. */
function edgeUse(triangles: readonly number[]) {
  const undirected = new Map<string, number>();
  const directed = new Map<string, number>();
  for (let t = 0; t < triangles.length; t += 3) {
    for (let side = 0; side < 3; side += 1) {
      const a = triangles[t + side] ?? 0;
      const b = triangles[t + ((side + 1) % 3)] ?? 0;
      const key = a < b ? `${a}:${b}` : `${b}:${a}`;
      undirected.set(key, (undirected.get(key) ?? 0) + 1);
      directed.set(`${a}:${b}`, (directed.get(`${a}:${b}`) ?? 0) + 1);
    }
  }
  return { directed, undirected };
}

const methods: SdfMeshMethod[] = ["surface-nets", "dual-contouring"];

describe.each(methods)("%s", (method) => {
  it("meshes a sphere watertight, manifold, oriented outward and on the surface", () => {
    const grid = lattice(0.1);
    const { chunks } = meshSdf(sphere, grid, {
      chunk: 8,
      method,
      skip: true,
    });
    const mesh = merged(chunks);
    const { directed, undirected } = edgeUse(mesh.triangles);
    expect([...undirected.values()].every((count) => count === 2)).toBe(true);
    expect([...directed.values()].every((count) => count === 1)).toBe(true);
    const vertices = mesh.positions.length / 3;
    const faces = mesh.triangles.length / 3;
    expect(vertices - undirected.size + faces).toBe(2);
    for (let index = 0; index < vertices; index += 1) {
      const d = sphere.distance(
        mesh.positions[index * 3] ?? 0,
        mesh.positions[index * 3 + 1] ?? 0,
        mesh.positions[index * 3 + 2] ?? 0
      );
      expect(Math.abs(d)).toBeLessThan(0.1 * grid.spacing);
    }
    // Anticlockwise from outside: each face's normal points away from the centre.
    let outward = 0;
    for (let t = 0; t < mesh.triangles.length; t += 3) {
      const [a, b, c] = [0, 1, 2].map((k) => {
        const id = mesh.triangles[t + k] ?? 0;
        return [0, 1, 2].map((axis) => mesh.positions[id * 3 + axis] ?? 0);
      }) as [number[], number[], number[]];
      const u = [0, 1, 2].map((axis) => (b[axis] ?? 0) - (a[axis] ?? 0));
      const v = [0, 1, 2].map((axis) => (c[axis] ?? 0) - (a[axis] ?? 0));
      const [nx, ny, nz] = [
        (u[1] ?? 0) * (v[2] ?? 0) - (u[2] ?? 0) * (v[1] ?? 0),
        (u[2] ?? 0) * (v[0] ?? 0) - (u[0] ?? 0) * (v[2] ?? 0),
        (u[0] ?? 0) * (v[1] ?? 0) - (u[1] ?? 0) * (v[0] ?? 0),
      ];
      if (nx * (a[0] ?? 0) + ny * (a[1] ?? 0) + nz * (a[2] ?? 0) > 0) {
        outward += 1;
      }
    }
    expect(outward).toBe(faces);
  });

  it("meshes a torus closed with genus one", () => {
    const { chunks } = meshSdf(torus, lattice(0.06), {
      chunk: 16,
      method,
      skip: true,
    });
    const mesh = merged(chunks);
    const { undirected } = edgeUse(mesh.triangles);
    expect([...undirected.values()].every((count) => count === 2)).toBe(true);
    const euler =
      mesh.positions.length / 3 - undirected.size + mesh.triangles.length / 3;
    expect(euler).toBe(0);
  });

  it("gives the same vertices chunked as whole, to the bit", () => {
    const grid = lattice(0.12);
    const whole = merged(
      meshSdf(box, grid, { chunk: 1000, method, skip: false }).chunks
    );
    const chunked = merged(
      meshSdf(box, grid, { chunk: 7, method, skip: false }).chunks
    );
    expect(chunked.positions.length).toBe(whole.positions.length);
    const key = (positions: number[]) => {
      const keys: string[] = [];
      for (let index = 0; index < positions.length; index += 3) {
        keys.push(positions.slice(index, index + 3).join(","));
      }
      return keys.sort();
    };
    expect(key(chunked.positions)).toEqual(key(whole.positions));
    expect(chunked.triangles.length).toBe(whole.triangles.length);
  });

  it("skips far samples without losing any of the surface", () => {
    const grid = lattice(0.08);
    const skipped = meshSdf(sphere, grid, { chunk: 16, method, skip: true });
    const full = meshSdf(sphere, grid, { chunk: 16, method, skip: false });
    expect(skipped.stats.skipped).toBeGreaterThan(0);
    expect(skipped.stats.triangles).toBe(full.stats.triangles);
  });
});

type Vec = [number, number, number];
const sub = (a: Vec, b: Vec): Vec => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a: Vec, b: Vec) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const along = (a: Vec, d: Vec, t: number): Vec => [
  a[0] + d[0] * t,
  a[1] + d[1] * t,
  a[2] + d[2] * t,
];

/** Distance from a point to a triangle, by its closest point (Ericson's regions). */
function pointTriangle(p: Vec, a: Vec, b: Vec, c: Vec): number {
  const ab = sub(b, a);
  const ac = sub(c, a);
  const ap = sub(p, a);
  const d1 = dot(ab, ap);
  const d2 = dot(ac, ap);
  if (d1 <= 0 && d2 <= 0) {
    return Math.hypot(...ap);
  }
  const bp = sub(p, b);
  const d3 = dot(ab, bp);
  const d4 = dot(ac, bp);
  if (d3 >= 0 && d4 <= d3) {
    return Math.hypot(...bp);
  }
  const vc = d1 * d4 - d3 * d2;
  if (vc <= 0 && d1 >= 0 && d3 <= 0) {
    return Math.hypot(...sub(p, along(a, ab, d1 / (d1 - d3))));
  }
  const cp = sub(p, c);
  const d5 = dot(ab, cp);
  const d6 = dot(ac, cp);
  if (d6 >= 0 && d5 <= d6) {
    return Math.hypot(...cp);
  }
  const vb = d5 * d2 - d1 * d6;
  if (vb <= 0 && d2 >= 0 && d6 <= 0) {
    return Math.hypot(...sub(p, along(a, ac, d2 / (d2 - d6))));
  }
  const va = d3 * d6 - d5 * d4;
  if (va <= 0 && d4 - d3 >= 0 && d5 - d6 >= 0) {
    return Math.hypot(
      ...sub(p, along(b, sub(c, b), (d4 - d3) / (d4 - d3 + (d5 - d6))))
    );
  }
  const denominator = 1 / (va + vb + vc);
  const v = vb * denominator;
  const w = vc * denominator;
  return Math.hypot(...sub(p, along(along(a, ab, v), ac, w)));
}

/** The furthest a point on the box's edges lies from the mesh, in lattice spacings. */
function edgeError(method: SdfMeshMethod, spacing: number): number {
  const mesh = merged(
    meshSdf(box, lattice(spacing), { chunk: 32, method, skip: false }).chunks
  );
  const vertex = (id: number): Vec => [
    mesh.positions[id * 3] ?? 0,
    mesh.positions[id * 3 + 1] ?? 0,
    mesh.positions[id * 3 + 2] ?? 0,
  ];
  const angle = 0.3;
  const half: Vec = [0.8, 0.6, 0.5];
  let worst = 0;
  // Points along the four edges parallel to z, away from the corners.
  for (const sx of [-1, 1]) {
    for (const sy of [-1, 1]) {
      for (let step = 0; step <= 10; step += 1) {
        const z = (step / 10 - 0.5) * 0.6;
        const lx = sx * half[0];
        const ly = sy * half[1];
        const p: Vec = [
          lx * Math.cos(angle) + ly * Math.sin(angle),
          -lx * Math.sin(angle) + ly * Math.cos(angle),
          z,
        ];
        let nearest = Number.POSITIVE_INFINITY;
        for (let t = 0; t < mesh.triangles.length; t += 3) {
          nearest = Math.min(
            nearest,
            pointTriangle(
              p,
              vertex(mesh.triangles[t] ?? 0),
              vertex(mesh.triangles[t + 1] ?? 0),
              vertex(mesh.triangles[t + 2] ?? 0)
            )
          );
        }
        worst = Math.max(worst, nearest);
      }
    }
  }
  return worst / spacing;
}

it("puts dual contouring's vertices on a box's edges where surface nets round them", () => {
  const spacing = 0.1;
  const nets = edgeError("surface-nets", spacing);
  const dual = edgeError("dual-contouring", spacing);
  expect(dual).toBeLessThan(0.05);
  expect(nets).toBeGreaterThan(0.2);
});

it("solves the point where three planes meet, and keeps a flat patch's mass point", () => {
  const corner = solveQef(
    [0.3, 0, 0, 0, 0.2, 0, 0, 0, 0.7],
    [1, 0, 0, 0, 1, 0, 0, 0, 1]
  );
  // The ridge damps the offset from the mass point by a few hundredths.
  for (const [axis, value] of [0.3, 0.2, 0.7].entries()) {
    expect(Math.abs((corner[axis] ?? 0) - value)).toBeLessThan(0.015);
  }
  const flat = solveQef(
    [0, 0, 0.5, 1, 0, 0.5, 0, 1, 0.5],
    [0, 0, 1, 0, 0, 1, 0, 0, 1]
  );
  expect(flat[2]).toBeCloseTo(0.5, 9);
  expect(flat[0]).toBeCloseTo(1 / 3, 9);
});
