import type { Object3D } from "three";
import type { MarkAlpha } from "../../layout/marks";

/**
 * What the three renderers (`strokes.ts`, `fills.ts`, `glyphs.ts`) share:
 * how marks are grouped into the objects that draw them, and how each
 * object is set up. The geometry of each kind is its own.
 */

/** What every batch key carries: the alpha the batch reads at the zoom and the plane it draws on. */
export interface MarkKey {
  alpha: MarkAlpha;
  /** Draped on an island's relief, or flat on the sea plane. */
  draped: boolean;
}

/** One batch as the mark layer keeps it: the object drawn and what it costs. */
export interface BuiltBatch<O extends Object3D = Object3D> {
  dispose: () => void;
  object: O;
  /** Stroke segments; 0 for a fill or glyph batch. */
  segments: number;
  setView: (pixelsPerUnit: number, pixelRatio: number) => void;
  /** Fill or glyph vertices; 0 for a stroke batch. */
  vertices: number;
}

/**
 * Items grouped by key, in the order the first item of each group appeared,
 * so a layer's marks still draw bottom to top within a kind. Two items
 * share a group when their keys have the same text.
 */
export function groupBy<Item, Key>(
  items: readonly Item[],
  keyOf: (item: Item) => Key,
  keyText: (key: Key) => string
): { items: Item[]; key: Key }[] {
  const groups = new Map<string, { items: Item[]; key: Key }>();
  for (const item of items) {
    const key = keyOf(item);
    const text = keyText(key);
    let group = groups.get(text);
    if (!group) {
      group = { items: [], key };
      groups.set(text, group);
    }
    group.items.push(item);
  }
  return [...groups.values()];
}

/** Held weakly: a layer that mints a function per build must not keep every one it ever made. */
const functionIds = new WeakMap<(pixelsPerUnit: number) => number, number>();
let functionCount = 0;

/**
 * A number or a function of the zoom as key text: the number itself, or a
 * stable id for the function, so two marks sharing one share a batch.
 */
export function zoomKeyText(
  value: number | ((pixelsPerUnit: number) => number)
): string {
  if (typeof value === "number") {
    return `=${value}`;
  }
  let id = functionIds.get(value);
  if (id === undefined) {
    id = functionCount;
    functionCount += 1;
    functionIds.set(value, id);
  }
  return `fn${id}`;
}

/**
 * How every mark material is set up: a flat mark tests depth, so the land
 * occludes it; a draped mark draws in order over the land instead, since a
 * screen-width ribbon on a rising shore would sink into it. None writes
 * depth, and all are translucent.
 */
export function markMaterialOptions(key: Pick<MarkKey, "draped">) {
  return { depthTest: !key.draped, depthWrite: false, transparent: true };
}

/** Places a batch's object in the draw order; nothing is culled, since a batch spans the chart. */
export function placeObject<O extends Object3D>(
  object: O,
  renderOrder: number
): O {
  object.renderOrder = renderOrder;
  object.frustumCulled = false;
  return object;
}
