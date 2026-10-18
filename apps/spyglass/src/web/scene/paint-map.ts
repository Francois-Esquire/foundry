import type { SpyglassData } from "../data/types";
import type { MapLabel } from "../layout/labels";
import { timeStage } from "../timings";
import type { InkView } from "../view/chart-view";
import { inkLayers } from "./ink/layers";
import { type InkOptions, inkState } from "./ink/state";

/**
 * The ink canvas at the view: every layer of `inkLayers`, in order, each in
 * its own drawing state and timed as `ink:<id>` in a developer session.
 * Returns the labels placed.
 */
export function paintInk(
  canvas: HTMLCanvasElement,
  options: InkOptions
): MapLabel[] {
  const ctx = canvas.getContext("2d");
  collectScale(ctx, canvas, options.view, options.data);
  const state = inkState(
    ctx,
    letteringContext(
      options.lettering?.canvas,
      ctx,
      options.view,
      options.data
    ),
    options
  );
  const contexts =
    state.labelContext === ctx ? [ctx] : [ctx, state.labelContext];
  for (const layer of inkLayers) {
    // Each layer starts from the scene's own drawing state and leaves none
    // behind: no layer's alpha, dash, font or fill reaches the next.
    for (const context of contexts) {
      context.save();
    }
    try {
      timeStage(options.developer ?? false, `ink:${layer.id}`, () =>
        layer.paint(state)
      );
    } finally {
      for (const context of contexts) {
        context.restore();
      }
    }
  }
  return state.labels;
}

function letteringContext(
  canvas: HTMLCanvasElement | undefined,
  fallback: CanvasRenderingContext2D,
  view: InkView | undefined,
  data: SpyglassData
) {
  if (!canvas) {
    return fallback;
  }
  const ctx = canvas.getContext("2d");
  collectScale(ctx, canvas, view, data);
  return ctx;
}

function collectScale(
  ctx: CanvasRenderingContext2D | null,
  canvas: HTMLCanvasElement,
  view: InkView | undefined,
  data: SpyglassData
): asserts ctx is CanvasRenderingContext2D {
  if (!ctx) {
    throw new Error("Canvas rendering is unavailable.");
  }
  const scale = canvas.width / (view?.width ?? data.width);
  ctx.resetTransform();
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.scale(scale, canvas.height / (view?.height ?? data.height));
  ctx.translate(
    (view?.width ?? data.width) / 2 - (view?.x ?? 0),
    (view?.height ?? data.height) / 2 - (view?.y ?? 0)
  );
}
