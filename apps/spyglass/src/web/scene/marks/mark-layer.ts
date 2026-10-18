import { Group } from "three";
import type { Fill, Glyph, Mark, Stroke } from "../../layout/marks";
import type { SeaRipple } from "../../layout/sea-ripples";
import type { InkView } from "../../view/chart-view";
import type { SceneLayer } from "../handle";
import type { ViewState } from "../view-state";
import { batchFills, createFillBatch } from "./fills";
import { batchGlyphs, createGlyphBatch } from "./glyphs";
import { batchStrokes, createStrokeBatch } from "./strokes";

/** The chart's fixed geometry a mark layer may read, beside the view state. */
export interface MarkChart {
  ripples: readonly SeaRipple[];
  /** The sea's extent, wider than the chart: as far as the camera may pan. */
  sea: { height: number; width: number };
}

/** What a mark layer reads each repaint. */
export interface MarkFrame {
  chart: MarkChart;
  state: Readonly<ViewState>;
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

/** What a mark layer costs: its marks, the geometry they became, and when it was last built. */
export interface MarkLayerStats {
  id: string;
  /** Milliseconds the last rebuild took. */
  lastRebuildMs: number;
  marks: number;
  rebuilds: number;
  /** Stroke segments drawn. */
  segments: number;
  /** Fill and glyph vertices drawn. */
  vertices: number;
}

/**
 * The marks draw after the sheets, which sort before them by depth, and
 * under the ink plane at render order 1: each batch takes a fraction of
 * one, by layer and then by batch, so a layer's batches keep their order.
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

function buildBatches(marks: readonly Mark[], layer: number): Built[] {
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
    built.push(createStrokeBatch(batch, markRenderOrder(layer, order)));
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
 * costs a pan nothing but those.
 */
export function markLayerNode(
  layer: MarkLayer,
  options: {
    chart: MarkChart;
    /** The layer's place among the mark layers, bottom first. */
    order: number;
    pixelRatio: () => number;
  }
): SceneLayer & { stats: () => MarkLayerStats } {
  const { chart, order, pixelRatio } = options;
  const group = new Group();
  let built: Built[] = [];
  let last: readonly Mark[] | undefined;
  const stats: MarkLayerStats = {
    id: layer.id,
    lastRebuildMs: 0,
    marks: 0,
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
  const rebuild = (marks: readonly Mark[]) => {
    const start = performance.now();
    clear();
    built = buildBatches(marks, order);
    for (const batch of built) {
      group.add(batch.object);
    }
    stats.marks = marks.length;
    stats.rebuilds += 1;
    stats.segments = built.reduce((sum, b) => sum + (b.segments ?? 0), 0);
    stats.vertices = built.reduce((sum, b) => sum + (b.vertices ?? 0), 0);
    stats.lastRebuildMs = performance.now() - start;
  };
  return {
    dispose: clear,
    group,
    id: layer.id,
    stats: () => ({ ...stats }),
    update(view, state) {
      const marks = layer.marks({ chart, state, view });
      if (marks !== last) {
        last = marks;
        rebuild(marks);
      }
      const ratio = pixelRatio();
      for (const batch of built) {
        batch.setView(view.pixelsPerUnit, ratio);
      }
    },
  };
}

/**
 * Marks built once from a few inputs, and kept while every input is the
 * same object: the memo a static layer needs so a pan never rebuilds it.
 */
export function staticMarks<const Inputs extends readonly unknown[]>(
  inputs: (frame: MarkFrame) => Inputs,
  produce: (...inputs: Inputs) => readonly Mark[]
): MarkLayer["marks"] {
  let seen: Inputs | undefined;
  let marks: readonly Mark[] = [];
  return (frame) => {
    const next = inputs(frame);
    if (!seen || next.some((input, i) => !Object.is(input, seen?.[i]))) {
      seen = next;
      marks = produce(...next);
    }
    return marks;
  };
}
