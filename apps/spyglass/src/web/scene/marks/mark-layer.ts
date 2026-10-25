import { Group } from "three";
import type { Territory } from "../../data/types";
import type { BoundaryLayers } from "../../layout/boundaries";
import type { Mark } from "../../layout/marks";
import type { SeaRipple } from "../../layout/sea-ripples";
import type { ReliefOf } from "../../layout/terrain-height";
import type { ContourLine } from "../../layout/topography";
import type { InkView } from "../../view/chart-view";
import type { SceneLayer } from "../handle";
import type { ViewState } from "../view-state";
import { type BuiltBatch, groupBy } from "./batch";
import { polygonGeometry, polylineVertices } from "./drape";
import { batchFills, createFillBatch } from "./fills";
import { batchGlyphs, createGlyphBatch } from "./glyphs";
import { batchStrokes, createStrokeBatch } from "./strokes";

/** The chart's fixed geometry a mark layer may read, beside the view state. */
export interface MarkChart {
  /** The layout's outlines a developer may turn on. */
  boundaries: BoundaryLayers;
  ripples: readonly SeaRipple[];
  /** The sea's extent, wider than the chart: as far as the camera may pan. */
  sea: { height: number; width: number };
  /** Every contour of the chart: the land's and the sea's rings. */
  topography: readonly ContourLine[];
}

/** What a mark layer reads each repaint. */
export interface MarkFrame {
  chart: MarkChart;
  state: Readonly<ViewState>;
  /** The clock's seconds since the scene opened, for a layer that moves. */
  time: number;
  view: InkView;
}

/**
 * One layer of the chart as marks: its name, and what it wants drawn for the
 * frame. Return the same array while nothing has changed and the layer's
 * objects are kept; a new array rebuilds them. A layer whose look changes
 * only with zoom says so through its marks' alphas, not a new array.
 */
export interface MarkLayer {
  id: string;
  marks: (frame: MarkFrame) => readonly Mark[];
}

/**
 * What a mark layer costs, for its node in the composition: its marks, the
 * objects drawn (one per batch of fills, strokes or glyphs), the stroke
 * segments and the fill and glyph vertices, how often it was built and the
 * milliseconds the last build took.
 */
interface MarkLayerStats extends Record<string, number> {
  batches: number;
  marks: number;
  rebuildMs: number;
  rebuilds: number;
  segments: number;
  vertices: number;
}

/**
 * The marks draw after the sea, which sorts before them by depth: a layer
 * takes one step of the order, and its batches share the step evenly, so a
 * layer's batches keep their order within it and a layer's last batch
 * always sorts under the next layer's first, however many it has.
 */
const layerStep = 0.001;
export function markRenderOrder(
  layer: number,
  batch: number,
  batches: number
): number {
  return layerStep * (1 + layer + batch / batches);
}

/**
 * The layer's compositing groups, lowest first. Within each group, fills,
 * strokes and glyphs batch by style; groups never merge, so a paper veil
 * can cover an earlier stroke while ordinary layers keep batching whole.
 */
function buildBatches(
  marks: readonly Mark[],
  layer: number,
  reliefOf: ReliefOf,
  islands: readonly Territory[]
): BuiltBatch[] {
  const groups = groupBy(marks, (mark) => mark.order ?? 0, String).sort(
    (a, b) => a.key - b.key
  );
  const builders = groups.flatMap(({ items }) => [
    ...batchFills(items.filter((mark) => mark.kind === "fill")).map(
      (batch) => (order: number) => createFillBatch(batch, order, reliefOf)
    ),
    ...batchStrokes(items.filter((mark) => mark.kind === "stroke")).map(
      (batch) => (order: number) =>
        createStrokeBatch(batch, order, reliefOf, islands)
    ),
    ...batchGlyphs(items.filter((mark) => mark.kind === "glyph")).map(
      (batch) => (order: number) => createGlyphBatch(batch, order, reliefOf)
    ),
  ]);
  return builders.map((build, index) =>
    build(markRenderOrder(layer, index, builders.length))
  );
}

/**
 * A mark layer as one of the scene's layers: on each update it asks the
 * layer for its marks and, only when it answers with a new array, rebuilds
 * its objects; otherwise it sets the frame's uniforms, so a static layer
 * costs a pan nothing but those. A rebuild reads the islands as drawn off
 * the state, for the strokes draped on the chart, since a relayout moves
 * them, and drapes every mark on the relief as drawn, which `reliefOf`
 * finds for a mark's island: a relayout replaces the island in the drawing
 * but not its relief. Its `prepare` does the costly part of a build ahead
 * of the frame: the marks the state asks for, whose clips are cached by
 * identity, and the draped geometry of each, cached by the island's relief
 * and the geometry, so the frame pays for the batching alone.
 */
export function markLayerNode(
  layer: MarkLayer,
  options: {
    chart: MarkChart;
    /** The layer's place among the mark layers, bottom first. */
    order: number;
    pixelRatio: () => number;
    /** The island whose relief is drawn, for a mark's island as drawn. */
    reliefOf: ReliefOf;
  }
): SceneLayer & { group: Group; stats: () => MarkLayerStats } {
  const { chart, order, pixelRatio, reliefOf } = options;
  const group = new Group();
  let built: BuiltBatch[] = [];
  let last: readonly Mark[] | undefined;
  const stats: MarkLayerStats = {
    batches: 0,
    marks: 0,
    rebuildMs: 0,
    rebuilds: 0,
    segments: 0,
    vertices: 0,
  };
  const clear = () => {
    for (const batch of built) {
      group.remove(batch.object);
      batch.dispose();
    }
    built = [];
  };
  const rebuild = (marks: readonly Mark[], islands: readonly Territory[]) => {
    const start = performance.now();
    clear();
    built = buildBatches(marks, order, reliefOf, islands);
    for (const batch of built) {
      group.add(batch.object);
    }
    stats.batches = built.length;
    stats.marks = marks.length;
    stats.rebuilds += 1;
    stats.segments = built.reduce((sum, b) => sum + b.segments, 0);
    stats.vertices = built.reduce((sum, b) => sum + b.vertices, 0);
    stats.rebuildMs = performance.now() - start;
  };
  return {
    dispose: clear,
    group,
    id: layer.id,
    kind: "marks",
    *prepare(view, state) {
      const marks = layer.marks({ chart, state, time: 0, view });
      yield;
      const { territories } = state.drawingData;
      for (const mark of marks) {
        if (mark.kind === "fill") {
          polygonGeometry(mark.polygon, mark.on, reliefOf);
          yield;
        } else if (mark.kind === "stroke" && mark.on) {
          polylineVertices(mark.points, mark.on, reliefOf, territories);
          yield;
        }
      }
    },
    stats: () => ({ ...stats }),
    update(view, state, time) {
      const marks = layer.marks({ chart, state, time, view });
      if (marks !== last) {
        last = marks;
        rebuild(marks, state.drawingData.territories);
      }
      const ratio = pixelRatio();
      for (const batch of built) {
        batch.setView(view.pixelsPerUnit, ratio, view.tilt);
      }
    },
  };
}

/**
 * Marks built from the frame and kept while every key is the same value:
 * the memo a layer needs so a pan never rebuilds it. Keys are the
 * identities and numbers the marks depend on, read off the state before
 * anything is derived from it, since a derived object is new each frame.
 */
export function keyedMarks(
  keys: (frame: MarkFrame) => readonly unknown[],
  produce: (frame: MarkFrame) => readonly Mark[]
): MarkLayer["marks"] {
  let seen: readonly unknown[] | undefined;
  let marks: readonly Mark[] = [];
  return (frame) => {
    const next = keys(frame);
    if (
      !seen ||
      next.length !== seen.length ||
      next.some((key, i) => !Object.is(key, seen?.[i]))
    ) {
      seen = next;
      marks = produce(frame);
    }
    return marks;
  };
}

/**
 * Marks built once from a few inputs, and kept while every input is the
 * same object: `keyedMarks` with the keys as the producer's arguments.
 */
export function staticMarks<const Inputs extends readonly unknown[]>(
  inputs: (frame: MarkFrame) => Inputs,
  produce: (...inputs: Inputs) => readonly Mark[]
): MarkLayer["marks"] {
  return keyedMarks(inputs, (frame) => produce(...inputs(frame)));
}
