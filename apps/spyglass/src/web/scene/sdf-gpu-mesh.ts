import {
  atomicLoad,
  atomicStore,
  Fn,
  float,
  select,
  storage,
  uint,
  uniform,
  vec2,
  vec3,
  vertexIndex,
} from "three/tsl";
import {
  IndirectStorageBufferAttribute,
  type Node,
  StorageBufferAttribute,
  type UniformNode,
} from "three/webgpu";

/**
 * The SDF trial's meshes on the GPU: one vertex buffer and one index
 * buffer shared by every island, each island owning a fixed range of
 * both, and one indirect draw's arguments a island. The passes append
 * into the island's range by atomic counters; an island's draw reads its
 * own arguments, so nothing is read back. A vertex is two texels: its
 * position and sky, then its normal (octahedral), sun and curvature.
 */

/** Texels a vertex takes. */
export const vertexTexels = 2;

/** Where an island's mesh goes in the shared buffers, as uniforms. */
export interface MeshUniforms {
  indexBase: UniformNode<"float", number>;
  indexCapacity: UniformNode<"float", number>;
  /** The island's slot among the draws' arguments. */
  slot: UniformNode<"float", number>;
  vertexBase: UniformNode<"float", number>;
  vertexCapacity: UniformNode<"float", number>;
}

export function meshUniforms(): MeshUniforms {
  return {
    indexBase: uniform(0),
    indexCapacity: uniform(0),
    slot: uniform(0),
    vertexBase: uniform(0),
    vertexCapacity: uniform(0),
  };
}

/** Each island's range of the shared buffers. */
export interface MeshRange {
  indexBase: number;
  indexCapacity: number;
  vertexBase: number;
  vertexCapacity: number;
}

/** The shared buffers for islands with the given capacities, and the cell map for `maxCells`. */
export function meshBuffers(
  capacities: readonly { indices: number; vertices: number }[],
  maxCells: number
) {
  const ranges: MeshRange[] = [];
  let vertices = 0;
  let indices = 0;
  for (const capacity of capacities) {
    ranges.push({
      indexBase: indices,
      indexCapacity: capacity.indices,
      vertexBase: vertices,
      vertexCapacity: capacity.vertices,
    });
    vertices += capacity.vertices;
    indices += capacity.indices;
  }
  const attributes = {
    /** Draw arguments, four a island: count, instances, first, first instance. */
    args: new IndirectStorageBufferAttribute(
      new Uint32Array(Math.max(1, capacities.length) * 4),
      4
    ),
    /** Each cell's vertex within the island's range, or none. */
    cells: new StorageBufferAttribute(
      new Uint32Array(Math.max(1, maxCells)),
      1
    ),
    /** The build's vertex and index counts. */
    counters: new StorageBufferAttribute(new Uint32Array(2), 1),
    indices: new StorageBufferAttribute(
      new Uint32Array(Math.max(1, indices)),
      1
    ),
    vertices: new StorageBufferAttribute(
      new Float32Array(Math.max(1, vertices) * vertexTexels * 4),
      4
    ),
  };
  const nodes = {
    args: storage(attributes.args, "uint", Math.max(1, capacities.length) * 4),
    cells: storage(attributes.cells, "uint", Math.max(1, maxCells)),
    counters: storage(attributes.counters, "uint", 2).toAtomic(),
    indices: storage(attributes.indices, "uint", Math.max(1, indices)),
    vertices: storage(
      attributes.vertices,
      "vec4",
      Math.max(1, vertices) * vertexTexels
    ),
  };
  const bytes = Object.values(attributes).reduce(
    (sum, attribute) => sum + attribute.array.byteLength,
    0
  );
  return { attributes, bytes, nodes, ranges };
}

export type MeshBuffers = ReturnType<typeof meshBuffers>;

/** No vertex: a cell the surface misses, or one past the island's capacity. */
export const noVertex = 0xff_ff_ff_ff;

/** Clears the counters before an island's build. */
export function resetPass(buffers: MeshBuffers) {
  return Fn(() => {
    atomicStore(buffers.nodes.counters.element(0), uint(0));
    atomicStore(buffers.nodes.counters.element(1), uint(0));
  });
}

/** Writes the island's draw arguments from its index count, held to its capacity. */
export function argsPass(buffers: MeshBuffers, uniforms: MeshUniforms) {
  return Fn(() => {
    const written = atomicLoad(buffers.nodes.counters.element(1)).toVar();
    const capacity = uint(uniforms.indexCapacity);
    const count = select(written.lessThan(capacity), written, capacity);
    const at = uint(uniforms.slot).mul(4);
    const { args } = buffers.nodes;
    args.element(at).assign(count);
    args.element(at.add(1)).assign(uint(1));
    args.element(at.add(2)).assign(uint(uniforms.indexBase));
    args.element(at.add(3)).assign(uint(0));
  });
}

/** A unit normal as two floats, octahedrally. */
export function encodeNormal(normal: Node<"vec3">): Node<"vec2"> {
  const n = normal.div(normal.abs().dot(vec3(1)));
  const folded = vec2(
    float(1).sub(n.y.abs()).mul(n.x.sign().max(0).mul(2).sub(1)),
    float(1).sub(n.x.abs()).mul(n.y.sign().max(0).mul(2).sub(1))
  );
  return n.z.lessThan(0).select(folded, n.xy);
}

/** The unit normal two floats encode. */
export function decodeNormal(encoded: Node<"vec2">): Node<"vec3"> {
  const z = float(1).sub(encoded.x.abs()).sub(encoded.y.abs());
  const t = z.negate().max(0);
  const x = encoded.x.sub(encoded.x.sign().max(0).mul(2).sub(1).mul(t));
  const y = encoded.y.sub(encoded.y.sign().max(0).mul(2).sub(1).mul(t));
  return vec3(x, y, z).normalize();
}

/**
 * A drawn vertex read from the shared buffers: the draw's vertex index
 * picks an index, which picks the vertex. Read-only views of the buffers,
 * as a vertex stage requires.
 */
export function pulledSurface(buffers: MeshBuffers) {
  const { attributes } = buffers;
  const indices = storage(
    attributes.indices,
    "uint",
    attributes.indices.count
  ).toReadOnly();
  const vertices = storage(
    attributes.vertices,
    "vec4",
    attributes.vertices.count
  ).toReadOnly();
  const id = indices.element(vertexIndex);
  const position = vertices.element(id.mul(vertexTexels));
  const extra = vertices.element(id.mul(vertexTexels).add(1));
  return {
    normal: decodeNormal(extra.xy),
    position: position.xyz,
    shade: vec3(position.w, extra.z, extra.w),
  };
}
