import {
  atomicLoad,
  Break,
  Fn,
  float,
  floor,
  If,
  instanceIndex,
  max,
  min,
  select,
  uint,
  vec3,
} from "three/tsl";
import type { Node } from "three/webgpu";
import type { ColumnStorages } from "./sdf-gpu-columns";
import type { FieldFunction } from "./sdf-gpu-field";
import { countLoop, type IslandUniforms } from "./sdf-gpu-island";
import {
  decodeNormal,
  type MeshBuffers,
  type MeshUniforms,
  vertexTexels,
} from "./sdf-gpu-mesh";

/**
 * The SDF trial's light on the GPU, each vertex's as the CPU trial baked
 * it: the sky's share by how much of the field stands within a few
 * distances along its normal, the sun's by sphere tracing the field
 * toward the sun (the classic soft shadow), and the curvature the land's
 * tone and the seabed's sediment read, the surface's means round the
 * vertex less its height. The field is the island's own, so a neighbour
 * casts no shadow on it.
 */

/** World units of the sun's direction, as the preview's light. */
const sun = (() => {
  const x = -600;
  const y = 700;
  const z = 700;
  const length = Math.hypot(x, y, z);
  return [x / length, y / length, z / length] as const;
})();

/** Reaches along the normal the sky's share is read at, and their weights. */
const skyTaps = [
  [0.6, 1],
  [1.5, 0.8],
  [3.5, 0.6],
  [7, 0.4],
] as const;

/** Map units over which the curvature's means are taken, as the CPU's raster means. */
const curvatureRadii = [8, 16, 32] as const;

/** Taps a side of each mean's grid. */
const curvatureTaps = 5;

/** The surface's height, world units, at a region point, bilinear between the columns. */
function surfaceAt(
  storages: ColumnStorages,
  uniforms: IslandUniforms,
  x: Node<"float">,
  y: Node<"float">
): Node<"float"> {
  const u = x.div(uniforms.spacing);
  const v = y.div(uniforms.spacing);
  const column = floor(u).clamp(0, uniforms.columns.sub(2));
  const row = floor(v).clamp(0, uniforms.rows.sub(2));
  const s = u.sub(column).clamp(0, 1);
  const t = v.sub(row).clamp(0, 1);
  const first = uint(row.mul(uniforms.columns).add(column));
  const width = uint(uniforms.columns);
  const at = (offset: Node<"uint">) => storages.surface.element(offset);
  const top = at(first)
    .mul(s.oneMinus())
    .add(at(first.add(1)).mul(s));
  const bottom = at(first.add(width))
    .mul(s.oneMinus())
    .add(at(first.add(width).add(1)).mul(s));
  return top.mul(t.oneMinus()).add(bottom.mul(t));
}

/** Pass 7: each vertex's sky, sun and curvature. */
export function lightPass(options: {
  buffers: MeshBuffers;
  exaggeration: number;
  field: FieldFunction;
  mesh: MeshUniforms;
  /** The chart's seabed height (world units) at a map position, which the means read beyond the region. */
  seabedAt: (x: Node<"float">, y: Node<"float">) => Node<"float">;
  storages: ColumnStorages;
  uniforms: IslandUniforms;
}) {
  const { buffers, exaggeration, field, mesh, seabedAt, storages, uniforms } =
    options;
  const { counters, vertices } = buffers.nodes;
  return Fn(() => {
    const id = instanceIndex.toVar();
    const count = atomicLoad(counters.element(0)).toVar();
    If(id.lessThan(count), () => {
      const at = uint(mesh.vertexBase).add(id).mul(vertexTexels).toVar();
      const position = vertices.element(at).toVar();
      const extra = vertices.element(at.add(1)).toVar();
      // The region frame: map units right and down, height over the floor.
      const p = vec3(
        position.x.sub(uniforms.left),
        position.y.negate().sub(uniforms.top),
        position.z.sub(uniforms.zLow)
      ).toVar();
      const world = decodeNormal(extra.xy);
      const n = vec3(world.x, world.y.negate(), world.z).toVar();
      // The sky's share.
      const lost = float(0).toVar();
      let weights = 0;
      for (const [reach, weight] of skyTaps) {
        const q = p.add(n.mul(reach));
        const d = field(q.x, q.y, q.z);
        lost.addAssign(float(reach).sub(d).div(reach).clamp(0, 1).mul(weight));
        weights += weight;
      }
      const sky = float(1).sub(lost.mul(0.85 / weights));
      // The sun's share, tracing the field toward the sun.
      const toSun = vec3(sun[0], -sun[1], sun[2]);
      const origin = p.add(n.mul(0.05)).toVar();
      const shade = float(1).toVar();
      const t = float(0.15).toVar();
      const width = uniforms.columns.sub(1).mul(uniforms.spacing);
      const height = uniforms.rows.sub(1).mul(uniforms.spacing);
      const ceiling = uniforms.layers.sub(1).mul(uniforms.spacing);
      countLoop("march", 0, 48, () => {
        const q = origin.add(toSun.mul(t)).toVar();
        const outside = q.z
          .greaterThan(ceiling)
          .or(q.x.lessThan(0))
          .or(q.y.lessThan(0))
          .or(q.x.greaterThan(width))
          .or(q.y.greaterThan(height))
          .or(t.greaterThan(60))
          .or(shade.lessThan(0.01));
        If(outside, () => {
          Break();
        });
        const d = field(q.x, q.y, q.z).toVar();
        shade.assign(min(shade, d.mul(10).div(t)));
        t.addAssign(d.clamp(0.08, 2));
      });
      const lit = shade.clamp(0, 1);
      const sunShare = lit.mul(lit).mul(lit.mul(-2).add(3));
      // The curvature: the surface's means round the vertex less its height.
      const sum = float(0).toVar();
      for (const radius of curvatureRadii) {
        const mean = float(0).toVar();
        for (let i = 0; i < curvatureTaps; i += 1) {
          for (let j = 0; j < curvatureTaps; j += 1) {
            const dx = ((2 * i) / (curvatureTaps - 1) - 1) * radius;
            const dy = ((2 * j) / (curvatureTaps - 1) - 1) * radius;
            const qx = p.x.add(dx).toVar();
            const qy = p.y.add(dy).toVar();
            const within = qx
              .greaterThanEqual(0)
              .and(qy.greaterThanEqual(0))
              .and(qx.lessThanEqual(width))
              .and(qy.lessThanEqual(height));
            mean.addAssign(
              select(
                within,
                surfaceAt(storages, uniforms, qx, qy),
                seabedAt(qx.add(uniforms.left), qy.add(uniforms.top))
              )
            );
          }
        }
        sum.addAssign(mean.div(curvatureTaps * curvatureTaps).sub(position.z));
      }
      const curvature = sum.div(curvatureRadii.length * exaggeration);
      vertices.element(at).assign(position.setW(max(sky, 0)));
      vertices.element(at.add(1)).assign(extra.setZ(sunShare).setW(curvature));
    });
  });
}
