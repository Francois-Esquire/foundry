import type { Continent } from "../continent";
import { continentCoasts } from "../continent";
import type { SpyglassData, Territory } from "../data/types";
import { unit } from "../geography";
import { grounds, packagePigments } from "../ladder/ink-ladder";
import { timeStage } from "../timings";
import type { InkView } from "../view/chart-view";
import type { MapLabel } from "./exploration";
import { inkLayers } from "./ink/layers";
import { type InkOptions, inkState } from "./ink/state";
import { trace } from "./ink/trace";
import { paintOcean } from "./ocean";

/** The sea sheet: the ocean's depth steps under every coast and continent. */
export function paintSea(
  canvas: HTMLCanvasElement,
  data: SpyglassData,
  continents: Continent[] = []
): void {
  const ctx = canvas.getContext("2d");
  collectScale(ctx, canvas, undefined, data);
  paintOcean(ctx, data, continentCoasts(data, continents));
}

/** The land sheet: shallows, island pigment and connecting land. */
export function paintCoast(
  canvas: HTMLCanvasElement,
  data: SpyglassData,
  continents: Continent[] = []
): void {
  const ctx = canvas.getContext("2d");
  collectScale(ctx, canvas, undefined, data);
  const joined = new Set(continents.flatMap((c) => c.members.map((p) => p.id)));
  for (const c of continents) {
    trace(
      ctx,
      c.field.outline.map((ring) => [ring])
    );
    ctx.fillStyle = grounds.continent;
    ctx.fill();
  }
  for (const p of data.territories) {
    paintLand(ctx, p, joined.has(p.id));
  }
}

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

function paintLand(
  ctx: CanvasRenderingContext2D,
  p: Territory,
  joined = false
): void {
  ctx.save();
  ctx.translate(p.x, p.y);
  if (!joined) {
    // Feathered so the fixed-resolution coast texture magnifies as a soft
    // depth change, never as stair-stepped texels.
    ctx.filter = "blur(3px)";
    trace(ctx, p.shallows);
    ctx.fillStyle = grounds.shallows;
    ctx.fill("evenodd");
    ctx.filter = "none";
  }
  trace(ctx, p.coast);
  ctx.fillStyle =
    packagePigments[
      Math.floor(unit(`${p.id}:pigment`) * packagePigments.length)
    ] ?? packagePigments[0];
  ctx.fill("evenodd");
  // The original pigment wash into warm stock; lighting supplies the relief.
  ctx.fillStyle = grounds.land;
  ctx.globalAlpha = 0.48;
  ctx.fill("evenodd");
  ctx.restore();
}
