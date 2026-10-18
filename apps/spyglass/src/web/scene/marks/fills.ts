import { BufferAttribute, type BufferGeometry, Mesh } from "three";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";
import { MeshBasicNodeMaterial } from "three/webgpu";
import { alphaAt, type Fill, type MarkAlpha } from "../../layout/marks";
import { polygonGeometry } from "./drape";
import { inkColour } from "./strokes";

interface FillKey {
  alpha: MarkAlpha;
  draped: boolean;
}

export interface FillBatch {
  fills: Fill[];
  key: FillKey;
}

/** Fills grouped by alpha and plane; colour is per vertex, so inks mix in a batch. */
export function batchFills(fills: readonly Fill[]): FillBatch[] {
  const batches: FillBatch[] = [];
  for (const fill of fills) {
    const draped = fill.on !== undefined;
    let batch = batches.find(
      (candidate) =>
        candidate.key.alpha === fill.alpha && candidate.key.draped === draped
    );
    if (!batch) {
      batch = { fills: [], key: { alpha: fill.alpha, draped } };
      batches.push(batch);
    }
    batch.fills.push(fill);
  }
  return batches;
}

/** One fill's triangles, coloured with its ink. */
function fillGeometry(fill: Fill): BufferGeometry {
  const geometry = polygonGeometry(fill.polygon, fill.on);
  const { count } = geometry.getAttribute("position");
  const { r, g, b } = inkColour(fill.colour);
  const colours = new Float32Array(count * 3);
  for (let i = 0; i < count; i += 1) {
    colours.set([r, g, b], i * 3);
  }
  geometry.setAttribute("color", new BufferAttribute(colours, 3));
  return geometry;
}

/** One batch as a mesh: flat fills test depth against the land; draped ones draw in order over it. */
export function createFillBatch(batch: FillBatch, renderOrder: number) {
  const { key } = batch;
  const parts = batch.fills.map(fillGeometry);
  const geometry = mergeGeometries(parts);
  for (const part of parts) {
    part.dispose();
  }
  const material = new MeshBasicNodeMaterial({
    depthTest: !key.draped,
    depthWrite: false,
    transparent: true,
    vertexColors: true,
  });
  const object = new Mesh(geometry, material);
  object.renderOrder = renderOrder;
  object.frustumCulled = false;
  return {
    dispose() {
      geometry.dispose();
      material.dispose();
    },
    object,
    setView(pixelsPerUnit: number) {
      material.opacity = alphaAt(key.alpha, pixelsPerUnit);
    },
    vertices: geometry.getAttribute("position").count,
  };
}
