import { float, Loop, uint, uniform } from "three/tsl";
import {
  type Node,
  StorageBufferAttribute,
  type UniformNode,
} from "three/webgpu";
import {
  columnStride,
  profileStride,
} from "../../lib/visualization/sdf-kernel";
import type { TrialIslandPlan } from "../layout/sdf-trial";

/**
 * The SDF trial's per-island state on the GPU: the uniforms every compute
 * pass reads to know which island it builds and on what lattice, and the
 * scratch buffers the passes share. One set of passes serves every
 * island: an island's build writes its uniforms, then runs each pass as
 * its own compute call, so the values it wrote take effect (a batched
 * call would keep only the last). Scratch is sized for the largest island
 * at the finest spacing and reused island after island; the queue runs
 * one island's passes before the next overwrites it.
 */

type FloatUniform = UniformNode<"float", number>;

/** What a pass needs to know of the island it builds. */
export interface IslandUniforms {
  /** Lattice columns and rows, map units apart by `spacing`. */
  columns: FloatUniform;
  /** Whether the island holds an atoll's lagoon, 1 or 0. */
  hasLagoon: FloatUniform;
  /** The island's index among the world's islands, its record's row. */
  island: FloatUniform;
  /** Z layers of lattice nodes from `zLow`. */
  layers: FloatUniform;
  /** The region's west and north edges, map units. */
  left: FloatUniform;
  /** The island's packed slab profile (`packSlabProfile`), one uniform a value. */
  profile: FloatUniform[];
  rows: FloatUniform;
  /** The island's coast segments, `[segmentStart, segmentEnd)` of the world's. */
  segmentEnd: FloatUniform;
  segmentStart: FloatUniform;
  spacing: FloatUniform;
  top: FloatUniform;
  zLow: FloatUniform;
}

export function islandUniforms(): IslandUniforms {
  return {
    columns: uniform(2),
    hasLagoon: uniform(0),
    island: uniform(0),
    layers: uniform(2),
    left: uniform(0),
    profile: Array.from({ length: profileStride }, () => uniform(0)),
    rows: uniform(2),
    segmentEnd: uniform(0),
    segmentStart: uniform(0),
    spacing: uniform(1),
    top: uniform(0),
    zLow: uniform(0),
  };
}

/** An island's lattice at a spacing: columns, rows and layers of nodes. */
export function islandLattice(plan: TrialIslandPlan, spacing: number) {
  const columns = Math.round(plan.width / spacing) + 1;
  const rows = Math.round(plan.height / spacing) + 1;
  const layers = Math.ceil((plan.zHigh - plan.zLow) / spacing) + 1;
  return { columns, layers, rows };
}

/** Writes an island's uniforms for a build at `spacing`. */
export function writeIslandUniforms(
  uniforms: IslandUniforms,
  plan: TrialIslandPlan,
  spacing: number,
  segments: { end: number; start: number }
): void {
  const lattice = islandLattice(plan, spacing);
  uniforms.columns.value = lattice.columns;
  uniforms.rows.value = lattice.rows;
  uniforms.layers.value = lattice.layers;
  uniforms.hasLagoon.value = plan.hasLagoon ? 1 : 0;
  uniforms.island.value = plan.index;
  uniforms.left.value = plan.left;
  uniforms.top.value = plan.top;
  uniforms.spacing.value = spacing;
  uniforms.zLow.value = plan.zLow;
  uniforms.segmentStart.value = segments.start;
  uniforms.segmentEnd.value = segments.end;
  for (const [slot, value] of plan.packed.entries()) {
    const node = uniforms.profile[slot];
    if (node) {
      node.value = value;
    }
  }
}

/** A float storage buffer of `count` items of `itemSize` floats. */
function floatBuffer(count: number, itemSize: 1 | 4) {
  return new StorageBufferAttribute(
    new Float32Array(Math.max(1, count) * itemSize),
    itemSize
  );
}

/** The scratch the passes share, sized for `columns` lattice columns and `nodes` lattice nodes. */
export function islandScratch(columns: number, nodes: number) {
  const scratch = {
    /** The kernel's columns, `columnStride` floats (three texels) each. */
    columns: floatBuffer((columns * columnStride) / 4, 4),
    /** Each column's four contour values: the lagoon's shore, then each escarpment's middle; inside where at least 0. */
    contours: floatBuffer(columns, 4),
    /** Each column's four footprint distances, map units: the bench, then each escarpment. */
    distances: floatBuffer(columns, 4),
    /** The field at every lattice node. */
    nodes: floatBuffer(nodes, 1),
    /** Each column's land (geology units), ground (geology units) and coast distance (map units). */
    raw: floatBuffer(columns, 4),
    /** Each column's surface height, world units, as the light reads it. */
    surface: floatBuffer(columns, 1),
  };
  const bytes = Object.values(scratch).reduce(
    (sum, buffer) => sum + buffer.array.byteLength,
    0
  );
  return { ...scratch, bytes };
}

export type IslandScratch = ReturnType<typeof islandScratch>;

/** A lattice column's index split into column and row, as unsigned nodes. */
export function columnOf(index: Node<"uint">, columns: FloatUniform) {
  const width = uint(columns);
  return { column: index.mod(width), row: index.div(width) };
}

/** The flat index of lattice column (column, row), clamped to the lattice; whole numbers as floats, exact to 2²⁴. */
export function columnIndex(
  column: Node<"float">,
  row: Node<"float">,
  uniforms: IslandUniforms
): Node<"uint"> {
  const c = column.clamp(0, uniforms.columns.sub(1));
  const r = row.clamp(0, uniforms.rows.sub(1));
  return uint(r.mul(uniforms.columns).add(c));
}

/** A lattice column's map position. */
export function columnPoint(
  column: Node<"uint">,
  row: Node<"uint">,
  uniforms: IslandUniforms
) {
  return {
    x: uniforms.left.add(float(column).mul(uniforms.spacing)),
    y: uniforms.top.add(float(row).mul(uniforms.spacing)),
  };
}

/** A named counting loop's parameters, as `LoopNode` reads them (its types omit `name`). */
type NamedLoop = (
  parameters: {
    condition: "<";
    end: Node<"int"> | number;
    name: string;
    start: Node<"int"> | number;
    type: "int";
  },
  body: (inputs: Record<string, Node<"int">>) => void
) => void;

/**
 * A counting loop in the shader, `start` to `end` exclusive, its counter
 * named so nested loops never share the default `i`.
 */
export function countLoop(
  name: string,
  start: Node<"int"> | number,
  end: Node<"int"> | number,
  body: (index: Node<"int">) => void
): void {
  (Loop as unknown as NamedLoop)(
    { condition: "<", end, name, start, type: "int" },
    (inputs) => body(inputs[name] as Node<"int">)
  );
}
