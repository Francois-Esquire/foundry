import {
  atomicAdd,
  Fn,
  If,
  instanceIndex,
  int,
  select,
  uint,
  vec3,
} from "three/tsl";
import type { Node } from "three/webgpu";
import type { FieldFunction, nodeStorage } from "./sdf-gpu-field";
import { nodeOf } from "./sdf-gpu-field";
import type { IslandUniforms } from "./sdf-gpu-island";
import {
  type MeshBuffers,
  type MeshUniforms,
  noVertex,
  vertexTexels,
} from "./sdf-gpu-mesh";

/**
 * Dual contouring's quad pass on the GPU, as `emitQuads` on the CPU: at
 * every lattice edge the surface crosses, the four cells round it joined
 * by a quad, split along the diagonal whose midpoint lies nearer the
 * surface, so a crease runs along a triangle's edge rather than across
 * it. The lattice runs right, down the chart and up, a mirror of the
 * world's axes, so each quad winds the CPU's way reversed.
 */

const axes = [
  [1, 0, 0],
  [0, 1, 0],
  [0, 0, 1],
] as const;

/** Pass 6: the quads round every node's three edges ahead of it. */
export function quadsPass(options: {
  buffers: MeshBuffers;
  field: FieldFunction;
  mesh: MeshUniforms;
  nodes: ReturnType<typeof nodeStorage>;
  uniforms: IslandUniforms;
}) {
  const { buffers, field, mesh, nodes, uniforms } = options;
  const { cells, counters, indices, vertices } = buffers.nodes;
  return Fn(() => {
    const index = instanceIndex.toVar();
    const { column, layer, row } = nodeOf(index, uniforms);
    const at = [int(column).toVar(), int(row).toVar(), int(layer).toVar()];
    const size = [
      int(uniforms.columns),
      int(uniforms.rows),
      int(uniforms.layers),
    ];
    const strides = [
      int(1),
      int(uniforms.columns),
      int(uniforms.columns).mul(int(uniforms.rows)),
    ];
    const value = nodes.element(index).toVar();
    /** The flat index of the cell at a lattice offset from the node, or -1 outside the cells. */
    const cellAt = (offset: readonly number[]) => {
      const coordinate = at.map((each, axis) =>
        each.add(int(offset[axis] ?? 0))
      );
      const inside = coordinate
        .map((each, axis) =>
          each
            .greaterThanEqual(int(0))
            .and(each.lessThan((size[axis] as Node<"int">).sub(1)))
        )
        .reduce((a, b) => a.and(b));
      const [c, r, l] = coordinate as [Node<"int">, Node<"int">, Node<"int">];
      const width = (size[0] as Node<"int">).sub(1);
      const height = (size[1] as Node<"int">).sub(1);
      const flat = l.mul(height).add(r).mul(width).add(c);
      return select(inside, flat, int(-1));
    };
    const vertexOf = (cell: Node<"int">) =>
      select(
        cell.greaterThanEqual(int(0)),
        cells.element(
          uint(select(cell.greaterThanEqual(int(0)), cell, int(0)))
        ),
        uint(noVertex)
      ).toVar();
    /** A vertex's position in the region frame. */
    const regionPoint = (id: Node<"uint">) => {
      const p = vertices.element(
        uint(mesh.vertexBase).add(id).mul(vertexTexels)
      );
      return vec3(
        p.x.sub(uniforms.left),
        p.y.negate().sub(uniforms.top),
        p.z.sub(uniforms.zLow)
      );
    };
    const off = (a: Node<"uint">, b: Node<"uint">) => {
      const mid = regionPoint(a).add(regionPoint(b)).mul(0.5).toVar();
      return field(mid.x, mid.y, mid.z).abs();
    };
    for (const [axis, step] of axes.entries()) {
      const ahead = (at[axis] as Node<"int">).add(1);
      const neighbour = nodes.element(
        uint(int(index).add(strides[axis] as Node<"int">))
      );
      If(ahead.lessThan(size[axis] as Node<"int">), () => {
        If(value.lessThan(0).xor(neighbour.lessThan(0)), () => {
          const b = axes[(axis + 1) % 3] ?? step;
          const e = axes[(axis + 2) % 3] ?? step;
          const q00 = vertexOf(cellAt(b.map((v, k) => -v - (e[k] ?? 0))));
          const q10 = vertexOf(cellAt(e.map((v) => -v)));
          const q11 = vertexOf(cellAt([0, 0, 0]));
          const q01 = vertexOf(cellAt(b.map((v) => -v)));
          const complete = q00
            .notEqual(uint(noVertex))
            .and(q10.notEqual(uint(noVertex)))
            .and(q11.notEqual(uint(noVertex)))
            .and(q01.notEqual(uint(noVertex)));
          If(complete, () => {
            // Mirrored lattice: the CPU's winding reversed.
            const inside = value.lessThan(0);
            const p1 = select(inside, q01, q10).toVar();
            const p3 = select(inside, q10, q01).toVar();
            const first = off(q00, q11).lessThanEqual(off(p1, p3));
            const slot = atomicAdd(counters.element(1), uint(6)).toVar();
            If(slot.add(6).lessThanEqual(uint(mesh.indexCapacity)), () => {
              const base = uint(mesh.indexBase).add(slot);
              const corners = [
                q00,
                p1,
                select(first, q11, p3),
                select(first, q00, p1),
                q11,
                p3,
              ];
              for (const [k, corner] of corners.entries()) {
                indices
                  .element(base.add(k))
                  .assign(uint(mesh.vertexBase).add(corner));
              }
            });
          });
        });
      });
    }
  });
}
