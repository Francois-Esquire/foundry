import { describe, expect, it } from "vitest";
import {
  fitView,
  panBy,
  svgTransform,
  toFont,
  toScreen,
  zoomAt,
} from "~/studio/view-transform";

const VIEW = { originX: 100, originY: 400, scale: 0.5 };

describe("the view transform", () => {
  it("puts the origin where the view says and flips the y axis", () => {
    expect(toScreen(VIEW, { x: 0, y: 0 })).toEqual({ x: 100, y: 400 });
    expect(toScreen(VIEW, { x: 200, y: 600 })).toEqual({ x: 200, y: 100 });
  });

  it("maps a screen point back to the font units it came from", () => {
    const point = { x: 317, y: -42 };
    const back = toFont(VIEW, toScreen(VIEW, point));
    expect(back.x).toBeCloseTo(point.x);
    expect(back.y).toBeCloseTo(point.y);
  });

  it("fits a box into a frame, centred, inside the margin", () => {
    const view = fitView(
      { height: 500, width: 800 },
      { xMax: 600, xMin: 0, yMax: 800, yMin: -200 },
      50
    );
    expect(view.scale).toBeCloseTo(0.4);
    expect(toScreen(view, { x: 300, y: 300 })).toEqual({ x: 400, y: 250 });
    expect(toScreen(view, { x: 0, y: 800 }).y).toBeCloseTo(50);
    expect(toScreen(view, { x: 0, y: -200 }).y).toBeCloseTo(450);
  });

  it("fits an empty box without dividing by zero", () => {
    const view = fitView(
      { height: 100, width: 100 },
      { xMax: 0, xMin: 0, yMax: 0, yMin: 0 }
    );
    expect(Number.isFinite(view.scale)).toBe(true);
  });

  it("zooms about the pointer, so the point under it stays put", () => {
    const anchor = { x: 260, y: 180 };
    const held = toFont(VIEW, anchor);
    const zoomed = zoomAt(VIEW, anchor, 2);
    expect(zoomed.scale).toBe(1);
    expect(toScreen(zoomed, held).x).toBeCloseTo(anchor.x);
    expect(toScreen(zoomed, held).y).toBeCloseTo(anchor.y);
  });

  it("stops zooming at its limits", () => {
    expect(zoomAt(VIEW, { x: 0, y: 0 }, 1e9).scale).toBe(40);
    expect(zoomAt(VIEW, { x: 0, y: 0 }, 1e-9).scale).toBe(0.01);
  });

  it("pans by screen pixels and keeps the scale", () => {
    expect(panBy(VIEW, 12, -7)).toEqual({
      originX: 112,
      originY: 393,
      scale: 0.5,
    });
  });

  it("writes the transform that draws font units on screen", () => {
    expect(svgTransform(VIEW)).toBe("translate(100 400) scale(0.5 -0.5)");
  });
});
