import { describe, expect, it } from "vitest";
import { layoutFigure } from "~/explorer/figure-layout";

const METRICS = {
  ascender: 800,
  capHeight: 700,
  descender: -200,
  lineGap: 0,
  unitsPerEm: 1000,
  xHeight: 500,
};
const SIZE = { height: 328, margin: 50, width: 400 };

describe("layoutFigure", () => {
  const figure = layoutFigure(
    {
      advance: 600,
      bounds: { xMax: 550, xMin: 50, yMax: 700, yMin: 0 },
      metrics: METRICS,
    },
    SIZE
  );

  it("fits ascender to descender in the height and centres the advance", () => {
    expect(figure.scale).toBeCloseTo(0.3);
    expect(figure.baselineY).toBeCloseTo(14 + 240);
    expect(figure.originX).toBeCloseTo(110);
    expect(figure.advanceX).toBeCloseTo(290);
  });

  it("places the metric lines from the top down, with the baseline at zero", () => {
    expect(figure.lines.map((line) => line.name)).toEqual([
      "Ascender",
      "Cap height",
      "x-height",
      "Baseline",
      "Descender",
    ]);
    const baseline = figure.lines.find((line) => line.name === "Baseline");
    expect(baseline?.y).toBeCloseTo(figure.baselineY);
    expect(figure.lines.every((line) => line.labelled)).toBe(true);
  });

  it("makes room for an outline that leaves the em box", () => {
    const tall = layoutFigure(
      {
        advance: 600,
        bounds: { xMax: 900, xMin: -100, yMax: 1200, yMin: -400 },
        metrics: METRICS,
      },
      SIZE
    );
    expect(tall.baselineY - 1200 * tall.scale).toBeCloseTo(14);
    expect(tall.originX - 100 * tall.scale).toBeGreaterThanOrEqual(50 - 0.001);
    expect(tall.originX + 900 * tall.scale).toBeLessThanOrEqual(350 + 0.001);
  });

  it("leaves out metrics the font does not state and labels that would collide", () => {
    const close = layoutFigure(
      {
        advance: 600,
        bounds: undefined,
        metrics: { ...METRICS, capHeight: 790, xHeight: 0 },
      },
      SIZE
    );
    expect(close.lines.map((line) => line.name)).toEqual([
      "Ascender",
      "Cap height",
      "Baseline",
      "Descender",
    ]);
    expect(
      close.lines.find((line) => line.name === "Cap height")?.labelled
    ).toBe(false);
  });
});
