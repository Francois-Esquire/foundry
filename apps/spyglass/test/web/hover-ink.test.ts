import { expect, it, vi } from "vitest";
import type { Territory } from "../../src/web/data/types";
import { inks } from "../../src/web/ladder/ink-ladder";
import { paintHoverInk } from "../../src/web/scene/hover-ink";

function context() {
  const strokes: { lineWidth: number; strokeStyle: string }[] = [];
  const ctx = {
    beginPath: vi.fn(),
    closePath: vi.fn(),
    lineJoin: "miter",
    lineTo: vi.fn(),
    lineWidth: 1,
    moveTo: vi.fn(),
    restore: vi.fn(),
    save: vi.fn(),
    setLineDash: vi.fn(),
    stroke: vi.fn(() => {
      strokes.push({ lineWidth: ctx.lineWidth, strokeStyle: ctx.strokeStyle });
    }),
    strokeStyle: "",
  };
  return { ctx, strokes };
}

const island = {
  coast: [
    [
      [
        [-10, -10],
        [10, -10],
        [10, 10],
        [-10, -10],
      ],
    ],
  ],
  x: 100,
  y: 50,
} as unknown as Territory;

it("inks the hovered island's coast at a constant screen width", () => {
  const { ctx, strokes } = context();
  paintHoverInk(ctx as unknown as CanvasRenderingContext2D, island, 4);
  expect(ctx.moveTo).toHaveBeenCalledWith(90, 40);
  expect(ctx.lineTo).toHaveBeenCalledWith(110, 60);
  expect(strokes.map((stroke) => stroke.lineWidth)).toEqual([1.5, 0.4]);
  expect(strokes.every((stroke) => stroke.strokeStyle === inks.hover)).toBe(
    true
  );
  expect(ctx.restore).toHaveBeenCalledTimes(1);
});

it("draws nothing without a hovered island", () => {
  const { ctx } = context();
  paintHoverInk(ctx as unknown as CanvasRenderingContext2D, null, 4);
  expect(ctx.stroke).not.toHaveBeenCalled();
  expect(ctx.save).not.toHaveBeenCalled();
});
