import { describe, expect, it } from "vitest";
import { chartGrid } from "../../src/web/data/bindings";
import type { Territory } from "../../src/web/data/types";
import { inkAlpha, inks } from "../../src/web/ladder/ink-ladder";
import { coastMarks } from "../../src/web/layout/coast-marks";
import { chartGridMarks } from "../../src/web/layout/grid-marks";
import { alphaAt, type Stroke } from "../../src/web/layout/marks";
import { coastPenRuns, penWeights } from "../../src/web/layout/pen-runs";
import {
  type MarkFrame,
  staticMarks,
} from "../../src/web/scene/marks/mark-layer";

const circle = Array.from({ length: 41 }, (_, index): [number, number] => [
  40 * Math.cos((index / 40) * Math.PI * 2),
  40 * Math.sin((index / 40) * Math.PI * 2),
]);

const shore: Territory = {
  analyzed: true,
  coast: [[circle]],
  fileRoles: undefined,
  files: [],
  folder: "",
  highFanInCutoff: 0,
  hills: [],
  id: "island",
  label: "Island",
  radius: 80,
  responsibilityGroups: undefined,
  shallows: [],
  x: 100,
  y: -50,
};

describe("chart grid marks", () => {
  it("rules the whole sea at fixed steps, minor lines fading with zoom", () => {
    const sea = { height: 360, width: 900 };
    const marks = chartGridMarks(sea);
    const { majorStep, minorStep } = chartGrid(1);
    const minor = marks.filter((mark) => mark.width === 0.5);
    const major = marks.filter((mark) => mark.width === 0.7);
    expect(minor).toHaveLength(
      Math.floor(900 / minorStep) + 1 + Math.floor(360 / minorStep) + 1
    );
    expect(major).toHaveLength(
      Math.floor(900 / majorStep) + 1 + Math.floor(360 / majorStep) + 1
    );
    expect(new Set(marks.map((mark) => mark.colour))).toEqual(
      new Set([inks.grid])
    );
    expect(marks.every((mark) => mark.on === undefined)).toBe(true);
    const vertical = major.find((mark) => mark.points[0] === 0);
    expect(vertical?.points).toEqual([0, -180, 0, 180]);
    expect(alphaAt(major[0]?.alpha ?? 0, 1)).toBe(inkAlpha.gridMajor);
    expect(alphaAt(minor[0]?.alpha ?? 0, 1)).toBe(0);
    expect(alphaAt(minor[0]?.alpha ?? 0, 4)).toBeCloseTo(0.14);
    // One shared alpha per step: the renderer keeps one batch each.
    expect(new Set(minor.map((mark) => mark.alpha)).size).toBe(1);
  });
});

describe("coast marks", () => {
  const strokesOf = (marks: readonly Stroke[], colour: string) =>
    marks.filter((mark) => mark.colour === colour);

  it("drapes a gilt rule, its frame and the pen on the island, in the chart's coordinates", () => {
    const marks = coastMarks([shore], null);
    expect(marks.every((mark) => mark.on === shore)).toBe(true);
    const [frame] = strokesOf(marks, inks.coastFrame);
    const [rule] = strokesOf(marks, inks.coastRule);
    expect(frame?.points.slice(0, 2)).toEqual([140, -50]);
    expect(rule?.points).toEqual(frame?.points);
    expect(frame?.width).toBeGreaterThan(rule?.width ?? 0);
    expect(frame?.alpha).toBe(inkAlpha.coastFrame);
    expect(rule?.alpha).toBe(1);
    // The frame draws first, so the rule sits over it.
    expect(marks.indexOf(frame as Stroke)).toBeLessThan(
      marks.indexOf(rule as Stroke)
    );
    const pen = strokesOf(marks, inks.coastPen);
    expect(pen.length).toBeGreaterThan(1);
    expect(new Set(pen.map((mark) => mark.width)).size).toBeGreaterThan(2);
    expect(pen.every((mark) => mark.alpha === inkAlpha.coastPen)).toBe(true);
    expect(pen.every((mark) => mark.cap === "round")).toBe(true);
  });

  it("inks the same pen pressure on every build, and presses harder when selected", () => {
    const widths = (selectedId: string | null) =>
      strokesOf(coastMarks([shore], selectedId), inks.coastPen).map(
        (mark) => mark.width
      );
    expect(widths(null)).toEqual(widths(null));
    expect(coastPenRuns(shore)).toBe(coastPenRuns(shore));
    const plain = widths(null);
    const selected = widths("island");
    expect(selected).toHaveLength(plain.length);
    for (const [index, width] of selected.entries()) {
      expect(width).toBeCloseTo((plain[index] ?? 0) * 1.3);
    }
    for (const width of plain) {
      expect(penWeights).toContain(width);
    }
  });
});

describe("static marks", () => {
  it("keeps the same array while its inputs are the same objects", () => {
    let built = 0;
    const marks = staticMarks(
      ({ state }) => [state.drawingData.territories, state.selected] as const,
      (_islands: readonly Territory[], _selected: string | null) => {
        built += 1;
        return [];
      }
    );
    const frameWith = (some: Territory[], selectedId: string | null) =>
      ({
        state: { drawingData: { territories: some }, selected: selectedId },
      }) as unknown as MarkFrame;
    const islands = [shore];
    const first = marks(frameWith(islands, null));
    expect(marks(frameWith(islands, null))).toBe(first);
    expect(built).toBe(1);
    expect(marks(frameWith(islands, "island"))).not.toBe(first);
    expect(marks(frameWith([shore], "island"))).not.toBe(first);
    expect(built).toBe(3);
  });
});
