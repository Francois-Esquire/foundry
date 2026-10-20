import { Fn, float, floor, instanceIndex, storage, uint } from "three/tsl";
import type { Node } from "three/webgpu";
import { kernelSlabField } from "../../lib/visualization/sdf-kernel";
import type { ColumnStorages } from "./sdf-gpu-columns";
import type { IslandScratch, IslandUniforms } from "./sdf-gpu-island";
import { nodeMath } from "./terrain-kernel-tsl";

/**
 * The SDF trial's field on the GPU: the slab kernel over an island's
 * columns, as `sdfIsland`'s `distance` evaluates it on the CPU. The field
 * at any world point is one WGSL function (`fieldAt`), so the passes that
 * read it many times (crossings, normals, light) call it rather than
 * inline it; the node pass reads its column directly, a node standing on
 * one.
 */

const channels = ["x", "y", "z", "w"] as const;

/** A column's three texels, held, read slot by slot. */
function heldColumn(storages: ColumnStorages, index: Node<"uint">) {
  const base = index.mul(3);
  const texels = [0, 1, 2].map((texel) =>
    storages.columns.element(base.add(texel)).toVar()
  );
  return (slot: number) =>
    (texels[Math.floor(slot / 4)] as Node<"vec4">)[
      channels[slot % 4] as "x"
    ] as Node<"float">;
}

/**
 * The field at a point of the island's region: map units right and down
 * from its north-west corner (`left`, `top`), and height `z` over the lattice's floor (`zLow`);
 * bilinear between the columns round it. Region coordinates keep single
 * precision fine where the chart's own run to a thousand units.
 */
export function fieldFunction(
  storages: ColumnStorages,
  uniforms: IslandUniforms
) {
  const profile = (slot: number) => uniforms.profile[slot] as Node<"float">;
  return Fn(([x, y, z]: Node<"float">[]) => {
    const u = (x as Node<"float">).div(uniforms.spacing);
    const v = (y as Node<"float">).div(uniforms.spacing);
    const column = floor(u).clamp(0, uniforms.columns.sub(2)).toVar();
    const row = floor(v).clamp(0, uniforms.rows.sub(2)).toVar();
    const s = u.sub(column).clamp(0, 1).toVar();
    const t = v.sub(row).clamp(0, 1).toVar();
    const first = uint(row.mul(uniforms.columns).add(column)).toVar();
    const width = uint(uniforms.columns);
    const corners = [
      heldColumn(storages, first),
      heldColumn(storages, first.add(1)),
      heldColumn(storages, first.add(width)),
      heldColumn(storages, first.add(width).add(1)),
    ];
    const weights = [
      s.oneMinus().mul(t.oneMinus()),
      s.mul(t.oneMinus()),
      s.oneMinus().mul(t),
      s.mul(t),
    ].map((weight) => weight.toVar());
    return kernelSlabField(
      nodeMath,
      (corner, slot) =>
        (corners[corner] as (slot: number) => Node<"float">)(slot),
      weights,
      (z as Node<"float">).add(uniforms.zLow),
      profile
    );
  }).setLayout({
    inputs: ["x", "y", "z"].map((name) => ({ name, type: "float" })),
    name: "sdfFieldAt",
    type: "float",
  });
}

export type FieldFunction = (
  x: Node<"float">,
  y: Node<"float">,
  z: Node<"float">
) => Node<"float">;

/** The lattice node storage, sized for `maxNodes`. */
export function nodeStorage(scratch: IslandScratch, maxNodes: number) {
  return storage(scratch.nodes, "float", maxNodes);
}

/** A lattice node's column, row and layer from its flat index, layer slowest. */
export function nodeOf(index: Node<"uint">, uniforms: IslandUniforms) {
  const plane = uint(uniforms.columns).mul(uint(uniforms.rows));
  const layer = index.div(plane);
  const within = index.mod(plane);
  return {
    column: within.mod(uint(uniforms.columns)),
    layer,
    row: within.div(uint(uniforms.columns)),
    within,
  };
}

/** Pass 4: the field at every lattice node, each on its own column. */
export function nodesPass(options: {
  nodes: ReturnType<typeof nodeStorage>;
  storages: ColumnStorages;
  uniforms: IslandUniforms;
}) {
  const { nodes, storages, uniforms } = options;
  const profile = (slot: number) => uniforms.profile[slot] as Node<"float">;
  return Fn(() => {
    const index = instanceIndex.toVar();
    const { layer, within } = nodeOf(index, uniforms);
    const z = uniforms.zLow.add(float(layer).mul(uniforms.spacing));
    const column = heldColumn(storages, within);
    nodes
      .element(index)
      .assign(
        kernelSlabField(
          nodeMath,
          (_, slot) => column(slot),
          [float(1)],
          z,
          profile
        )
      );
  });
}
