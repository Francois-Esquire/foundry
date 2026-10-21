import type { ComputeNode, Renderer } from "three/webgpu";
import { coastSegments } from "../../lib/visualization/screen-terrain-coast";
import type { TrialPlan } from "../layout/sdf-trial";
import { screenTerrainInputs } from "./screen-terrain-bake";
import { cellsPass } from "./sdf-gpu-cells";
import { columnStorages, columnsPass, fieldsPass } from "./sdf-gpu-columns";
import { footprintsPass } from "./sdf-gpu-contours";
import {
  type FieldFunction,
  fieldFunction,
  nodeStorage,
  nodesPass,
} from "./sdf-gpu-field";
import {
  islandLattice,
  islandScratch,
  islandUniforms,
  writeIslandUniforms,
} from "./sdf-gpu-island";
import { lightPass } from "./sdf-gpu-light";
import { argsPass, meshBuffers, meshUniforms, resetPass } from "./sdf-gpu-mesh";
import { quadsPass } from "./sdf-gpu-quads";
import { seabedGrid } from "./sdf-gpu-seabed";

/**
 * The SDF trial on the GPU: every island's signed distance and mesh built
 * in compute passes from the plan, with nothing read back. One set of
 * passes serves every island; `build` runs them for one island at one
 * spacing, each pass its own compute call so the island's uniforms hold.
 */

/** The finest spacing an island is built at, which the scratch is sized for. */
const finestSpacing = 0.5;

/**
 * Vertices an island's range holds a lattice column at the finest
 * spacing, and indices a vertex: the surface crosses a column about once,
 * more where it climbs a wall, and dual contouring makes about one quad a
 * vertex.
 */
const capacity = { indicesPerVertex: 6.2, verticesPerColumn: 1.6 };

/** Each island's coast segments as a range of the world's: they are listed island by island. */
function segmentRanges(plan: TrialPlan) {
  const { world } = plan.chart;
  const segments = coastSegments(world.islands, world.islandIds);
  const ranges = world.islandIds.map(() => ({ end: 0, start: 0 }));
  for (const [at, island] of segments.island.entries()) {
    const range = ranges[island];
    if (range) {
      if (range.end === 0) {
        range.start = at;
      }
      range.end = at + 1;
    }
  }
  return ranges;
}

export function createSdfGpu(plan: TrialPlan) {
  const inputs = screenTerrainInputs(plan.chart);
  const sizes = plan.islands.map((island) => {
    const lattice = islandLattice(island, finestSpacing);
    return {
      columns: lattice.columns * lattice.rows,
      nodes: lattice.columns * lattice.rows * lattice.layers,
    };
  });
  const maxColumns = Math.max(1, ...sizes.map((size) => size.columns));
  const maxNodes = Math.max(1, ...sizes.map((size) => size.nodes));
  const uniforms = islandUniforms();
  const scratch = islandScratch(maxColumns, maxNodes);
  const storages = columnStorages(scratch, maxColumns);
  const ranges = segmentRanges(plan);
  const buffers = meshBuffers(
    sizes.map((size) => {
      const vertices = Math.ceil(size.columns * capacity.verticesPerColumn);
      return {
        indices: Math.ceil(vertices * capacity.indicesPerVertex),
        vertices,
      };
    }),
    maxNodes
  );
  const mesh = meshUniforms();
  const nodes = nodeStorage(scratch, maxNodes);
  // Each pass its own field function: a layout function's code is built
  // once, with the uniform names of the shader it was first built in.
  const field = () =>
    fieldFunction(storages, uniforms) as unknown as FieldFunction;
  const pass = (fn: () => unknown, count: number) =>
    (fn as unknown as () => { compute: (n: number) => ComputeNode })().compute(
      count
    );
  const seabed = seabedGrid(plan, inputs);
  const passes = {
    args: pass(argsPass(buffers, mesh), 1),
    cells: pass(
      cellsPass({ buffers, field: field(), mesh, nodes, uniforms }),
      maxNodes
    ),
    columns: pass(columnsPass({ storages, uniforms }), maxColumns),
    fields: pass(
      fieldsPass({ chart: plan.chart, inputs, storages, uniforms }),
      maxColumns
    ),
    footprints: pass(footprintsPass({ storages, uniforms }), maxColumns),
    light: pass(
      lightPass({
        buffers,
        exaggeration: plan.islands[0]?.slabs.exaggeration ?? 1,
        field: field(),
        mesh,
        seabedAt: seabed.heightAt,
        storages,
        uniforms,
      }),
      1
    ),
    nodes: pass(nodesPass({ nodes, storages, uniforms }), maxNodes),
    quads: pass(
      quadsPass({ buffers, field: field(), mesh, nodes, uniforms }),
      maxNodes
    ),
    reset: pass(resetPass(buffers), 1),
  };
  const run = (renderer: Renderer, node: ComputeNode, count: number) => {
    node.count = count;
    renderer.compute(node);
  };

  /**
   * One island's build (by its place in the plan) at `spacing`: writes its
   * uniforms and lists its passes, each run as its own compute call.
   */
  const steps = (which: number, spacing: number) => {
    const island = plan.islands[which];
    const range = buffers.ranges[which];
    if (!(island && range)) {
      return [];
    }
    writeIslandUniforms(
      uniforms,
      island,
      spacing,
      ranges[island.index] ?? { end: 0, start: 0 }
    );
    mesh.indexBase.value = range.indexBase;
    mesh.indexCapacity.value = range.indexCapacity;
    mesh.vertexBase.value = range.vertexBase;
    mesh.vertexCapacity.value = range.vertexCapacity;
    mesh.slot.value = which;
    const lattice = islandLattice(island, spacing);
    const columns = lattice.columns * lattice.rows;
    const nodeCount = columns * lattice.layers;
    const cellCount =
      (lattice.columns - 1) * (lattice.rows - 1) * (lattice.layers - 1);
    return [
      { count: 1, name: "reset", node: passes.reset },
      { count: columns, name: "fields", node: passes.fields },
      { count: columns, name: "footprints", node: passes.footprints },
      { count: columns, name: "columns", node: passes.columns },
      { count: nodeCount, name: "nodes", node: passes.nodes },
      { count: cellCount, name: "cells", node: passes.cells },
      { count: nodeCount, name: "quads", node: passes.quads },
      { count: range.vertexCapacity, name: "light", node: passes.light },
      { count: 1, name: "args", node: passes.args },
    ];
  };

  /** Builds one island (by its place in the plan) at `spacing`. */
  const build = (renderer: Renderer, which: number, spacing: number) => {
    for (const step of steps(which, spacing)) {
      run(renderer, step.node, step.count);
    }
  };

  return {
    buffers,
    build,
    /** Builds the seabed beyond the islands' regions. */
    buildSeabed(renderer: Renderer) {
      renderer.compute(seabed.heightsPass);
      renderer.compute(seabed.lightPass);
    },
    bytes: scratch.bytes + inputs.bytes + buffers.bytes + seabed.bytes,
    dispose() {
      inputs.dispose();
    },
    inputs,
    passes,
    readColumns: async (renderer: Renderer) =>
      new Float32Array(await renderer.getArrayBufferAsync(scratch.columns)),
    /** A developer's readback of the last build's columns, `columnStride` floats each. */
    readCounters: async (renderer: Renderer) => [
      ...new Uint32Array(
        await renderer.getArrayBufferAsync(buffers.attributes.counters)
      ),
    ],
    readVertices: async (renderer: Renderer) =>
      new Float32Array(
        await renderer.getArrayBufferAsync(buffers.attributes.vertices)
      ),
    run,
    scratch,
    seabed,
    steps,
  };
}

export type SdfGpu = ReturnType<typeof createSdfGpu>;
