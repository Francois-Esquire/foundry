import { describe, expect, it } from "vitest";
import { hitComposition } from "../../src/web/composition-hit";
import {
  compositionFrame,
  compositionMotionFits,
  compositionReveal,
} from "../../src/web/composition-motion";
import type { ResponsibilityOverlay } from "../../src/web/responsibility-focus";
import type { Territory } from "../../src/web/types";

const territory: Territory = {
  analyzed: true,
  coast: [
    [
      [
        [-20, -20],
        [20, -20],
        [20, 20],
        [-20, 20],
        [-20, -20],
      ],
    ],
  ],
  color: "#aaa",
  files: [
    {
      directory: "src",
      id: "file",
      incoming: 0,
      kind: "source",
      outgoing: 0,
      path: "src/file.ts",
      x: 0,
      y: 0,
    },
  ],
  hills: [],
  id: "package",
  label: "Package",
  neighborhoods: [],
  radius: 20,
  shallows: [],
  x: 0,
  y: 0,
};
const overlay: ResponsibilityOverlay = {
  composition: {
    active: [],
    fileId: "file",
    marks: [{ group: "local", id: "symbol", x: 5, y: 0 }],
    names: { symbol: "Example" },
  },
  links: [],
  members: ["file"],
  pathDisagreement: [],
  related: [],
  territoryId: "package",
  totalLinks: 0,
  unresolved: [],
};

describe("composition interaction", () => {
  it("rejects motion across holes and detached land while accepting clear interior motion", () => {
    const coast = structuredClone(territory.coast);
    coast[0]?.push([
      [1, -2],
      [3, -2],
      [3, 2],
      [1, 2],
      [1, -2],
    ]);
    expect(
      compositionMotionFits(
        [
          { x: 0, y: 0 },
          { x: 5, y: 0 },
        ],
        coast
      )
    ).toBe(false);
    expect(
      compositionMotionFits(
        [
          { x: -10, y: -10 },
          { x: -6, y: -10 },
        ],
        coast
      )
    ).toBe(true);
    expect(compositionMotionFits([], coast)).toBe(false);
    expect(
      compositionMotionFits(
        [
          { x: 0, y: 0 },
          { x: 30, y: 0 },
        ],
        coast
      )
    ).toBe(false);
    expect(
      compositionMotionFits(
        [
          { x: -4, y: -6 },
          { x: 8, y: -6 },
          { x: 2, y: 8 },
        ],
        coast
      )
    ).toBe(false);
  });
  it("fades unsafe and reduced-motion declarations at fitted positions with matching hit targets", () => {
    for (const reducedMotion of [false, true]) {
      const value: ResponsibilityOverlay = {
        ...overlay,
        composition: overlay.composition && {
          ...overlay.composition,
          stationary: reducedMotion ? [] : ["symbol"],
        },
        reducedMotion,
        trace: {
          blockers: [],
          marks: [{ group: "proposed", id: "symbol", x: 13, y: 0 }],
          progress: 0.5,
          stationary: reducedMotion ? [] : ["symbol"],
        },
      };
      for (const pixels of [6.5, 7, 8]) {
        expect(compositionFrame(value, pixels)[0]).toEqual({
          ghost: { alpha: 0.5, tether: false, x: 13, y: 0 },
          id: "symbol",
          x: 5,
          y: 0,
        });
        expect(hitComposition(territory, value, 13, 0, pixels)?.symbol.id).toBe(
          "symbol"
        );
        expect(hitComposition(territory, value, 9, 0, pixels)).toBeNull();
      }
      if (value.trace) {
        value.trace.progress = 0;
      }
      expect(compositionFrame(value, 8)[0]?.ghost).toBeUndefined();
      expect(hitComposition(territory, value, 13, 0, 8)).toBeNull();
    }
  });
  it("selects the actual declaration identity at current and traced positions", () => {
    const traced = {
      ...overlay,
      trace: {
        blockers: [],
        marks: [{ group: "proposed", id: "symbol", x: 13, y: 0 }],
        progress: 0.5,
      },
    };
    const before = structuredClone(traced);
    expect(hitComposition(territory, traced, 5, 0, 8)?.symbol).toEqual({
      id: "symbol",
      name: "Example",
    });
    expect(hitComposition(territory, traced, 9, 0, 8)?.symbol).toEqual({
      id: "symbol",
      name: "Example",
    });
    expect(traced).toEqual(before);
  });
  it("uses the same local reveal coordinates as paint and ignores hidden detail", () => {
    const { spread } = compositionReveal(7);
    expect(
      hitComposition(territory, overlay, 5 * spread, 0, 7)?.symbol.id
    ).toBe("symbol");
    expect(hitComposition(territory, overlay, 5, 0, 6)).toBeNull();
    expect(hitComposition(territory, overlay, 30, 0, 8)).toBeNull();
    expect(
      hitComposition({ ...territory, files: [] }, overlay, 5, 0, 8)
    ).toBeNull();
  });
});
