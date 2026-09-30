import { expect, it, vi } from "vitest";

import {
  atlasBoundaries,
  boundaryStyles,
  defaultBoundaries,
  paintBoundaries,
} from "../../src/web/scene/boundaries";
import { loadAtlas } from "../helpers/reference-atlas";

it("retains every computational boundary independently of layer visibility", async () => {
  const data = await loadAtlas();
  const before = structuredClone(data.territories);
  const layers = atlasBoundaries(data);
  expect(layers.outer).toHaveLength(1);
  expect(layers.groups.length).toBeGreaterThan(0);
  expect(layers.footprint.length).toBeGreaterThan(0);
  expect(layers.pockets.length).toBeGreaterThan(0);
  expect(layers.clearance).toHaveLength(data.territories.length);
  expect(layers.coasts.length).toBeGreaterThanOrEqual(data.territories.length);
  const stroke = vi.fn();
  const ctx = {
    beginPath: vi.fn(),
    bezierCurveTo: vi.fn(),
    closePath: vi.fn(),
    moveTo: vi.fn(),
    restore: vi.fn(),
    save: vi.fn(),
    setLineDash: vi.fn(),
    stroke,
  } as unknown as CanvasRenderingContext2D;
  const hidden = {
    clearance: false,
    coasts: false,
    footprint: false,
    groups: false,
    outer: false,
    pockets: false,
  };
  paintBoundaries(ctx, layers, hidden, 1);
  expect(stroke).not.toHaveBeenCalled();
  for (const key of Object.keys(
    boundaryStyles
  ) as (keyof typeof boundaryStyles)[]) {
    stroke.mockClear();
    paintBoundaries(ctx, layers, { ...hidden, [key]: true }, 1);
    expect(stroke).toHaveBeenCalledTimes(layers[key].length);
  }
  expect(data.territories).toEqual(before);
  expect(defaultBoundaries).toEqual(hidden);
});
