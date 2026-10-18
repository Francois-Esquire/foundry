import { Group } from "three";
import type { Territory } from "../../data/types";
import type { BoundaryLayers } from "../../layout/boundaries";
import type { Fill, Glyph, Mark, Stroke } from "../../layout/marks";
import type { SeaRipple } from "../../layout/sea-ripples";
import type { ContourLine } from "../../layout/topography";
import type { InkView } from "../../view/chart-view";
import type { SceneLayer } from "../handle";
import type { ViewState } from "../view-state";
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
 * The marks draw after the sea, which sorts before them by depth: each
 * batch takes a fraction of one, by layer and then by batch, so a layer's
 * batches keep their order.
 */
const batchesPerLayer = 32;
const orderStep = 0.001;
export function markRenderOrder(layer: number, batch: number): number {
  return orderStep * (1 + layer * batchesPerLayer + batch);
}

interface Built {
  dispose: () => void;
  object: Group["children"][number];
  segments?: number;
  setView: (pixelsPerUnit: number, pixelRatio: number) => void;
  vertices?: number;
}

function buildBatches(
  marks: readonly Mark[],
  layer: number,
  territories: readonly Territory[]
): Built[] {
  const strokes: Stroke[] = [];
  const fills: Fill[] = [];
  const glyphs: Glyph[] = [];
  for (const mark of marks) {
    if (mark.kind === "stroke") {
      strokes.push(mark);
    } else if (mark.kind === "fill") {
      fills.push(mark);
    } else {
      glyphs.push(mark);
    }
  }
  const built: Built[] = [];
  let order = 0;
  for (const batch of batchFills(fills)) {
    built.push(createFillBatch(batch, markRenderOrder(layer, order)));
    order += 1;
  }
  for (const batch of batchStrokes(strokes)) {
    built.push(
      createStrokeBatch(batch, markRenderOrder(layer, order), territories)
    );
    order += 1;
  }
  for (const batch of batchGlyphs(glyphs)) {
    built.push(createGlyphBatch(batch, markRenderOrder(layer, order)));
    order += 1;
  }
  return built;
}

/**
 * A mark layer as one of the scene's layers: on each update it asks the
 * layer for its marks and, only when it answers with a new array, rebuilds
 * its objects; otherwise it sets the frame's uniforms, so a static layer
 * costs a pan nothing but those. A rebuild reads the islands as drawn off
 * the state, for the strokes draped on the chart, since a relayout moves
 * them. Its `prepare` does the costly part of a build ahead of the frame:
 * the marks the state asks for, whose clips are cached by identity, and
 * the draped geometry of each, cached the same way, so the frame pays for
 * the batching alone.
 */
export function markLayerNode(
  layer: MarkLayer,
  options: {
    chart: MarkChart;
    /** The layer's place among the mark layers, bottom first. */
    order: number;
    pixelRatio: () => number;
  }
): SceneLayer & { group: Group; stats: () => MarkLayerStats } {
  const { chart, order, pixelRatio } = options;
  const group = new Group();
  let built: Built[] = [];
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
  const rebuild = (
    marks: readonly Mark[],
    territories: readonly Territory[]
  ) => {
    const start = performance.now();
    clear();
    built = buildBatches(marks, order, territories);
    for (const batch of built) {
      group.add(batch.object);
    }
    stats.batches = built.length;
    stats.marks = marks.length;
    stats.rebuilds += 1;
    stats.segments = built.reduce((sum, b) => sum + (b.segments ?? 0), 0);
    stats.vertices = built.reduce((sum, b) => sum + (b.vertices ?? 0), 0);
    stats.rebuildMs = performance.now() - start;
  };
  return {
    dispose: clear,
    group,
    id: layer.id,
    *prepare(view, state) {
      const marks = layer.marks({ chart, state, time: 0, view });
      yield;
      const { territories } = state.drawingData;
      for (const mark of marks) {
        if (mark.kind === "fill") {
          polygonGeometry(mark.polygon, mark.on);
          yield;
        } else if (mark.kind === "stroke" && mark.on) {
          polylineVertices(mark.points, mark.on, territories);
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
        batch.setView(view.pixelsPerUnit, ratio);
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
