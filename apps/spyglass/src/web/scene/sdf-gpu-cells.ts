import {
  atomicAdd,
  Fn,
  float,
  If,
  instanceIndex,
  max,
  min,
  uint,
  vec3,
  vec4,
} from "three/tsl";
import type { Node } from "three/webgpu";
import { kernelQefOffset, qefRidge } from "../../lib/visualization/sdf-kernel";
import type { FieldFunction, nodeStorage } from "./sdf-gpu-field";
import { countLoop, type IslandUniforms } from "./sdf-gpu-island";
import {
  encodeNormal,
  type MeshBuffers,
  type MeshUniforms,
  noVertex,
  vertexTexels,
} from "./sdf-gpu-mesh";
import { nodeMath } from "./terrain-kernel-tsl";

/**
 * Dual contouring's cell pass on the GPU, as `sdf-mesh.ts` places a
 * vertex on the CPU: in every lattice cell whose corners disagree in
 * sign, each edge's crossing found by false position on the field itself,
 * the field's normal there, and the closed-form least-squares point of
 * their planes, held within the cell and half a cell's slack. Points are
 * in the island's region frame (map units right and down from its
 * north-west corner, world height up); a cell's maths is relative to its
 * lowest corner.
 */

/** Share of a cell beyond its own faces a vertex may stand, as the CPU's. */
const dualSlack = 0.5;

/** Share of a lattice step the normals' central differences span. */
const normalStep = 0.02;

/** False-position steps toward an edge's crossing. */
const crossingSteps = 6;

/** The field's unit gradient at a region point. */
function normalFunction(field: FieldFunction, uniforms: IslandUniforms) {
  return Fn(([point]: Node<"vec3">[]) => {
    const p = (point as Node<"vec3">).toVar();
    const h = uniforms.spacing.mul(normalStep).toVar();
    const along = (axis: Node<"vec3">) =>
      field(
        p.x.add(axis.x.mul(h)),
        p.y.add(axis.y.mul(h)),
        p.z.add(axis.z.mul(h))
      ).sub(
        field(
          p.x.sub(axis.x.mul(h)),
          p.y.sub(axis.y.mul(h)),
          p.z.sub(axis.z.mul(h))
        )
      );
    const gradient = vec3(
      along(vec3(1, 0, 0)),
      along(vec3(0, 1, 0)),
      along(vec3(0, 0, 1))
    );
    return gradient.div(max(gradient.length(), 1e-12));
  }).setLayout({
    inputs: [{ name: "point", type: "vec3" }],
    name: "sdfNormalAt",
    type: "vec3",
  });
}

/** Where the field crosses zero between region points `a` and `b`, whose values are `fa` and `fb`. */
function crossingFunction(field: FieldFunction) {
  return Fn(([a, b, fa, fb]: Node<"float">[]) => {
    const from = a as unknown as Node<"vec3">;
    const to = b as unknown as Node<"vec3">;
    const lo = float(0).toVar();
    const hi = float(1).toVar();
    const flo = (fa as Node<"float">).toVar();
    const fhi = (fb as Node<"float">).toVar();
    countLoop("step", 0, crossingSteps, () => {
      const share = flo.div(flo.sub(fhi)).clamp(0.05, 0.95);
      const t = lo.add(hi.sub(lo).mul(share)).toVar();
      const p = from.add(to.sub(from).mul(t)).toVar();
      const value = field(p.x, p.y, p.z).toVar();
      If(value.lessThan(0).xor(flo.lessThan(0)).not(), () => {
        lo.assign(t);
        flo.assign(value);
      }).Else(() => {
        hi.assign(t);
        fhi.assign(value);
      });
    });
    const t = lo.add(hi.sub(lo).mul(flo).div(flo.sub(fhi)));
    return from.add(to.sub(from).mul(t));
  }).setLayout({
    inputs: [
      { name: "a", type: "vec3" },
      { name: "b", type: "vec3" },
      { name: "fa", type: "float" },
      { name: "fb", type: "float" },
    ],
    name: "sdfCrossing",
    type: "vec3",
  });
}

/** A cell's column, row and layer from its flat index, layer slowest. */
function cellOf(index: Node<"uint">, uniforms: IslandUniforms) {
  const width = uint(uniforms.columns).sub(1);
  const height = uint(uniforms.rows).sub(1);
  const rest = index.div(width);
  return {
    column: index.mod(width),
    layer: rest.div(height),
    row: rest.mod(height),
  };
}

/** The twelve edges of a cell as corner pairs; a corner's bits are its column, row and layer offsets. */
const cellEdges: readonly [number, number][] = [0, 1, 2, 3, 4, 5, 6, 7].flatMap(
  (corner) =>
    [1, 2, 4]
      .filter((bit) => Math.floor(corner / bit) % 2 === 0)
      .map((bit): [number, number] => [corner, corner + bit])
);

const cornerOffset = (corner: number) =>
  [corner % 2, Math.floor(corner / 2) % 2, Math.floor(corner / 4)] as const;

/** Pass 5: each cell's vertex, appended to the island's range, and the cell map. */
export function cellsPass(options: {
  buffers: MeshBuffers;
  field: FieldFunction;
  mesh: MeshUniforms;
  nodes: ReturnType<typeof nodeStorage>;
  uniforms: IslandUniforms;
}) {
  const { buffers, field, mesh, nodes, uniforms } = options;
  const normalAt = normalFunction(field, uniforms);
  const crossingAt = crossingFunction(field) as unknown as (
    a: Node<"vec3">,
    b: Node<"vec3">,
    fa: Node<"float">,
    fb: Node<"float">
  ) => Node<"vec3">;
  const normalOf = normalAt as unknown as (p: Node<"vec3">) => Node<"vec3">;
  return Fn(() => {
    const index = instanceIndex.toVar();
    const { column, layer, row } = cellOf(index, uniforms);
    const columns = uint(uniforms.columns);
    const plane = columns.mul(uint(uniforms.rows));
    const first = layer.mul(plane).add(row.mul(columns)).add(column).toVar();
    const values = [0, 1, 2, 3, 4, 5, 6, 7].map((corner) => {
      const [dc, dr, dl] = cornerOffset(corner);
      const at = first.add(columns.mul(dr)).add(plane.mul(dl)).add(uint(dc));
      return nodes.element(at).toVar() as Node<"float">;
    });
    const low = values.reduce((a, b) => min(a, b));
    const high = values.reduce((a, b) => max(a, b));
    const s = uniforms.spacing;
    buffers.nodes.cells.element(index).assign(uint(noVertex));
    If(low.lessThan(0).and(high.greaterThanEqual(0)), () => {
      // The cell's lowest corner in the region frame.
      const origin = vec3(
        float(column).mul(s),
        float(row).mul(s),
        float(layer).mul(s)
      ).toVar();
      const mass = vec3(0).toVar();
      const count = float(0).toVar();
      const ata = [0, 1, 2, 3, 4, 5].map(() => float(0).toVar());
      const atbRaw = vec3(0).toVar();
      for (const [c0, c1] of cellEdges) {
        const v0 = values[c0] as Node<"float">;
        const v1 = values[c1] as Node<"float">;
        If(v0.lessThan(0).xor(v1.lessThan(0)), () => {
          const a = vec3(...cornerOffset(c0)).mul(s);
          const b = vec3(...cornerOffset(c1)).mul(s);
          const local = crossingAt(a.add(origin), b.add(origin), v0, v1)
            .sub(origin)
            .toVar();
          const n = normalOf(local.add(origin)).toVar();
          mass.addAssign(local);
          count.addAssign(1);
          const products = [
            n.x.mul(n.x),
            n.x.mul(n.y),
            n.x.mul(n.z),
            n.y.mul(n.y),
            n.y.mul(n.z),
            n.z.mul(n.z),
          ];
          for (const [slot, product] of products.entries()) {
            (ata[slot] as Node<"float">).addAssign(product);
          }
          atbRaw.addAssign(n.mul(n.dot(local)));
        });
      }
      mass.divAssign(max(count, 1));
      const [xx, xy, xz, yy, yz, zz] = ata as unknown as [
        Node<"float">,
        Node<"float">,
        Node<"float">,
        Node<"float">,
        Node<"float">,
        Node<"float">,
      ];
      // About the mass point: Aᵀb = Σ n (n·(p − m)) = Σ n (n·p) − AᵀA m.
      const atb = atbRaw
        .sub(
          vec3(
            xx.mul(mass.x).add(xy.mul(mass.y)).add(xz.mul(mass.z)),
            xy.mul(mass.x).add(yy.mul(mass.y)).add(yz.mul(mass.z)),
            xz.mul(mass.x).add(yz.mul(mass.y)).add(zz.mul(mass.z))
          )
        )
        .toVar();
      const offset = kernelQefOffset(
        nodeMath,
        [xx, xy, xz, yy, yz, zz],
        [atb.x, atb.y, atb.z],
        count.mul(qefRidge)
      );
      const slack = s.mul(dualSlack);
      const local = mass
        .add(vec3(offset[0], offset[1], offset[2]))
        .clamp(slack.negate(), s.add(slack))
        .add(origin)
        .toVar();
      const normal = normalOf(local).toVar();
      const id = atomicAdd(buffers.nodes.counters.element(0), uint(1)).toVar();
      If(id.lessThan(uint(mesh.vertexCapacity)), () => {
        buffers.nodes.cells.element(index).assign(id);
        const at = uint(mesh.vertexBase).add(id).mul(vertexTexels);
        // World units: x right, y up the chart, z up.
        buffers.nodes.vertices
          .element(at)
          .assign(
            vec4(
              local.x.add(uniforms.left),
              local.y.add(uniforms.top).negate(),
              local.z.add(uniforms.zLow),
              1
            )
          );
        const world = vec3(normal.x, normal.y.negate(), normal.z);
        buffers.nodes.vertices
          .element(at.add(1))
          .assign(vec4(encodeNormal(world), 1, 0));
      });
    });
  });
}
