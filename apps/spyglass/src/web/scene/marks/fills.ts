import { BufferAttribute, type BufferGeometry, Mesh } from "three";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";
import { MeshBasicNodeMaterial } from "three/webgpu";
import { alphaAt, type Fill } from "../../layout/marks";
import type { ReliefOf } from "../../layout/terrain-height";
import {
  groupBy,
  type MarkKey,
  markMaterialOptions,
  placeObject,
  zoomKeyText,
} from "./batch";
import { polygonGeometry } from "./drape";
import { inkColour } from "./ink";

export interface FillBatch {
  fills: Fill[];
  key: MarkKey;
}

const keyOf = (fill: Fill): MarkKey => ({
  alpha: fill.alpha,
  draped: fill.on !== undefined,
});

const keyText = (key: MarkKey): string =>
  `${key.draped ? "draped" : "flat"}|${zoomKeyText(key.alpha)}`;

/** Fills grouped by alpha and plane; colour is per vertex, so inks mix in a batch. */
export function batchFills(fills: readonly Fill[]): FillBatch[] {
  return groupBy(fills, keyOf, keyText).map(({ items, key }) => ({
    fills: items,
    key,
  }));
}

/** One fill's triangles, coloured with its ink: a copy of the kept geometry, so the batch may dispose it. */
function fillGeometry(fill: Fill, reliefOf: ReliefOf): BufferGeometry {
  const geometry = polygonGeometry(fill.polygon, fill.on, reliefOf).clone();
  const { count } = geometry.getAttribute("position");
  const { r, g, b } = inkColour(fill.colour);
  const colours = new Float32Array(count * 3);
  for (let i = 0; i < count; i += 1) {
    colours.set([r, g, b], i * 3);
  }
  geometry.setAttribute("color", new BufferAttribute(colours, 3));
  return geometry;
}

/** One batch as a mesh: flat fills test depth against the land; draped ones draw in order over it, lifted onto the relief as drawn, which `reliefOf` finds for each fill's island. */
export function createFillBatch(
  batch: FillBatch,
  renderOrder: number,
  reliefOf: ReliefOf
) {
  const { key } = batch;
  const parts = batch.fills.map((fill) => fillGeometry(fill, reliefOf));
  const geometry = mergeGeometries(parts);
  for (const part of parts) {
    part.dispose();
  }
  const material = new MeshBasicNodeMaterial({
    ...markMaterialOptions(key),
    vertexColors: true,
  });
  const object = placeObject(new Mesh(geometry, material), renderOrder);
  return {
    dispose() {
      geometry.dispose();
      material.dispose();
    },
    object,
    segments: 0,
    setView(pixelsPerUnit: number) {
      material.opacity = alphaAt(key.alpha, pixelsPerUnit);
    },
    vertices: geometry.getAttribute("position").count,
  };
}
