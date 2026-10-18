import assert from "node:assert/strict";
import { expect, it, vi } from "vitest";
import type { SpyglassData } from "../../src/web/data/types";
import { inks } from "../../src/web/ladder/ink-ladder";
import { paintCrossings } from "../../src/web/scene/ink/crossings";
import { inkState } from "../../src/web/scene/ink/state";
import { twins } from "../helpers/twins";

/** A 2D context that records what is stroked and filled, in which ink. */
function canvasFixture() {
  const ctx = {
    arc: vi.fn(),
    beginPath: vi.fn(),
    clearRect: vi.fn(),
    clip: vi.fn(),
    closePath: vi.fn(),
    createLinearGradient: () => ({ addColorStop: vi.fn() }),
    fill: vi.fn(),
    fillRect: vi.fn(),
    fillStyle: "",
    fillText: vi.fn(),
    globalAlpha: 1,
    lineTo: vi.fn(),
    measureText: (text: string) => ({ width: text.length * 1.5 }),
    moveTo: vi.fn(),
    quadraticCurveTo: vi.fn(),
    rect: vi.fn(),
    resetTransform: vi.fn(),
    restore: vi.fn(),
    rotate: vi.fn(),
    save: vi.fn(),
    scale: vi.fn(),
    setLineDash: vi.fn(),
    stroke: vi.fn(),
    strokeRect: vi.fn(),
    strokeStyle: "",
    strokeText: vi.fn(),
    translate: vi.fn(),
  };
  return {
    canvas: {
      getContext: () => ctx,
      height: 500,
      width: 500,
    } as unknown as HTMLCanvasElement,
    ctx,
  };
}

/** The whole chart at one pixel per unit. */
const whole = (spyglass: SpyglassData) => ({
  height: spyglass.height,
  pixelsPerUnit: 1,
  width: spyglass.width,
  x: 0,
  y: 0,
});

/** The crossing lines `paintCrossings` strokes, in the crossing's ink, with an island selected or none. */
function crossingStrokes(spyglass: SpyglassData, selected: string | null) {
  const { ctx } = canvasFixture();
  const inksStroked: string[] = [];
  ctx.stroke.mockImplementation(() => inksStroked.push(ctx.strokeStyle));
  const pen = ctx as unknown as CanvasRenderingContext2D;
  paintCrossings(
    inkState(pen, { data: spyglass, selected, view: whole(spyglass) })
  );
  return {
    curves: ctx.quadraticCurveTo.mock.calls.length,
    inks: inksStroked,
  };
}

it("draws one line for each pair of packages a crossing joins, in the crossing's ink, and none for a single workspace", async () => {
  const { spyglass, single } = await twins();
  const [crossing] = spyglass.crossings ?? [];
  assert(crossing);
  // Two declarations of one pair, and the pair the other way round.
  const merged: SpyglassData = {
    ...spyglass,
    crossings: [
      crossing,
      { ...crossing, kind: "devDependencies" },
      { ...crossing, from: crossing.to, to: crossing.from },
    ],
  };
  const drawn = crossingStrokes(merged, null);
  expect(drawn.curves).toBe(2);
  expect(new Set(drawn.inks)).toEqual(new Set([inks.crossing]));
  expect(crossingStrokes(single, null).curves).toBe(0);
  // Never a route.
  expect(
    merged.routes.some(
      (route) => route.from === crossing.from && route.to === crossing.to
    )
  ).toBe(false);
});

it("keeps only the selected island's own crossings while an island is selected", async () => {
  const { spyglass } = await twins();
  const [crossing] = spyglass.crossings ?? [];
  assert(crossing);
  const other = spyglass.territories.find(
    (island) => island.id !== crossing.from && island.id !== crossing.to
  );
  assert(other);
  expect(crossingStrokes(spyglass, crossing.from).curves).toBe(1);
  expect(crossingStrokes(spyglass, crossing.to).curves).toBe(1);
  expect(crossingStrokes(spyglass, other.id).curves).toBe(0);
});
