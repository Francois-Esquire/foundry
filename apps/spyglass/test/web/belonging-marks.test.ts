import { describe, expect, it } from "vitest";
import type { SpyglassFile, Territory } from "../../src/web/data/types";
import { inkStyle } from "../../src/web/ladder/ink-ladder";
import type {
  BelongingLayer,
  BelongingRegion,
} from "../../src/web/layout/belonging";
import {
  type BelongingMarkInputs,
  belongingMarks,
} from "../../src/web/layout/belonging-marks";
import { belongingView } from "../../src/web/layout/belonging-view";
import {
  alphaAt,
  type Fill,
  type Glyph,
  type Mark,
  type Stroke,
} from "../../src/web/layout/marks";

const file = (id: string, x: number, y: number): SpyglassFile => ({
  directory: "src",
  highFanIn: false,
  id,
  incoming: 0,
  internalFanIn: 0,
  kind: "source",
  outgoing: 0,
  path: `src/${id}.ts`,
  x,
  y,
});

/** A square ring from −half to half. */
const box = (half: number): [number, number][] => [
  [-half, -half],
  [half, -half],
  [half, half],
  [-half, half],
  [-half, -half],
];

const island: Territory = {
  analyzed: true,
  coast: [[box(50)]],
  fileRoles: undefined,
  files: [file("inside", 0, 0), file("shore", 60, 0)],
  folder: "",
  highFanInCutoff: 0,
  hills: [],
  id: "island",
  label: "Island",
  radius: 80,
  responsibilityGroups: undefined,
  shallows: [],
  x: 100,
  y: -40,
};

/** A district reaching past the coast on the east. */
const region = (overrides: Partial<BelongingRegion> = {}): BelongingRegion => ({
  color: "#688c77",
  id: "region",
  label: "Region",
  members: island.files,
  polygons: [
    [
      [
        [-30, -30],
        [70, -30],
        [70, 70],
        [-30, 70],
        [-30, -30],
      ],
    ],
  ],
  uncertain: false,
  ...overrides,
});

const inputs = (
  belonging: BelongingLayer | null,
  overrides: Partial<BelongingMarkInputs> = {}
): BelongingMarkInputs => ({
  activeRegion: undefined,
  baselineRegionId: undefined,
  belonging,
  districtFloor: 0,
  hasComposition: false,
  matches: undefined,
  pixels: 2.2,
  responsibility: null,
  streams: false,
  ...overrides,
});

const fills = (marks: readonly Mark[]) =>
  marks.filter((mark): mark is Fill => mark.kind === "fill");
const strokes = (marks: readonly Mark[]) =>
  marks.filter((mark): mark is Stroke => mark.kind === "stroke");
const glyphs = (marks: readonly Mark[]) =>
  marks.filter((mark): mark is Glyph => mark.kind === "glyph");

describe("belonging marks", () => {
  it("cuts a district's wash and outline to the coast, draped on the island, and never strokes the coast itself", () => {
    const marks = belongingMarks(
      inputs({ regions: [region()], territory: island })
    );
    expect(marks.every((mark) => mark.on === island)).toBe(true);
    const [wash] = fills(marks);
    expect(wash?.colour).toBe("#688c77");
    for (const [x, y] of wash?.polygon.flat() ?? []) {
      expect(x - island.x).toBeGreaterThanOrEqual(-30);
      expect(x - island.x).toBeLessThanOrEqual(50);
      expect(y - island.y).toBeGreaterThanOrEqual(-30);
      expect(y - island.y).toBeLessThanOrEqual(50);
    }
    const outline = strokes(marks);
    expect(outline.length).toBeGreaterThan(0);
    for (const { points, width } of outline) {
      expect(width).toBe(0.7);
      for (let i = 2; i + 1 < points.length; i += 2) {
        // No run along the coast's eastern edge.
        const alongCoast =
          points[i - 2] === island.x + 50 && points[i] === island.x + 50;
        expect(alongCoast).toBe(false);
      }
    }
  });

  it("keeps the same polygons and polylines across rebuilds, so the renderer keeps their draping", () => {
    const layer = { regions: [region()], territory: island };
    const first = belongingMarks(inputs(layer));
    const again = belongingMarks(inputs(layer, { pixels: 3 }));
    expect(fills(again)[0]?.polygon).toBe(fills(first)[0]?.polygon);
    expect(strokes(again)[0]?.points).toBe(strokes(first)[0]?.points);
  });

  it("fades the pigment with the zoom and brings it up with the reveal, sharing one alpha per base", () => {
    const [a, b] = [region({ id: "a" }), region({ id: "b" })];
    const marks = belongingMarks(
      inputs({ regions: [a, b], reveal: 0.5, territory: island })
    );
    const [first, second] = fills(marks);
    expect(first?.alpha).toBe(second?.alpha);
    expect(alphaAt(first?.alpha ?? 0, 2.2)).toBeCloseTo(0.14 * 0.5);
    expect(alphaAt(first?.alpha ?? 0, 1)).toBe(0);
    // An entered group's parents keep a floor under the pigment.
    const floored = belongingMarks(
      inputs({ regions: [a], territory: island }, { districtFloor: 0.2 })
    );
    expect(alphaAt(fills(floored)[0]?.alpha ?? 0, 1)).toBeCloseTo(0.14 * 0.2);
  });

  it("emphasises the active region and dashes an uncertain one, whose outline surfaces with zoom", () => {
    const active = region({ id: "active" });
    const uncertain = region({ id: "unresolved", uncertain: true });
    const marks = belongingMarks(
      inputs(
        { emphasis: 0.5, regions: [active, uncertain], territory: island },
        { activeRegion: active }
      )
    );
    const [activeFill, uncertainFill] = fills(marks);
    expect(alphaAt(activeFill?.alpha ?? 0, 2.2)).toBeCloseTo(0.14 + 0.08);
    expect(alphaAt(uncertainFill?.alpha ?? 0, 2.2)).toBeCloseTo(0.045);
    const activeOutline = strokes(marks).find((mark) => mark.width === 1.5);
    expect(activeOutline?.dash).toBeUndefined();
    expect(alphaAt(activeOutline?.alpha ?? 0, 2.2)).toBeCloseTo(0.3 + 0.275);
    const dashed = strokes(marks).find((mark) => mark.dash);
    expect(dashed?.dash).toEqual(inkStyle("unresolved-outline").dash);
    expect(alphaAt(dashed?.alpha ?? 0, 3)).toBeCloseTo(0.1);
    expect(alphaAt(dashed?.alpha ?? 0, 2.2)).toBeCloseTo(2.2 / 30);
  });

  it("draws the entered group's parents with their anchors, and its members outside the district as squares", () => {
    const parent = region({
      anchor: island.files[0],
      children: ["region"],
      id: "parent",
      polygons: [[box(20)]],
    });
    const neighbour = region({ ...parent, id: "neighbour" });
    const marks = belongingMarks(
      inputs({
        files: island.files,
        parents: [parent],
        regions: [region()],
        surroundings: [neighbour],
        territory: island,
      })
    );
    const anchors = glyphs(marks).filter((mark) => mark.shape === "frame");
    expect(anchors).toHaveLength(2);
    expect(anchors[0]).toMatchObject({ size: 9, weight: 1, x: 100, y: -40 });
    // The neighbour draws first and fainter.
    expect(alphaAt(anchors[0]?.alpha ?? 0, 2.2)).toBeCloseTo(0.35);
    expect(alphaAt(anchors[1]?.alpha ?? 0, 2.2)).toBeCloseTo(0.85);
    const squares = glyphs(marks).filter((mark) => mark.shape === "square");
    // "inside" sits in the parent's district; "shore" lies outside it.
    expect(squares).toHaveLength(1);
    expect(squares[0]).toMatchObject({ size: 3, x: 160, y: -40 });
    // The district's wash is cut to the enclosing parent as well as the coast.
    const district = fills(marks).at(-1);
    for (const [x, y] of district?.polygon.flat() ?? []) {
      expect(Math.abs(x - island.x)).toBeLessThanOrEqual(20);
      expect(Math.abs(y - island.y)).toBeLessThanOrEqual(20);
    }
  });

  it("draws nothing without a layer", () => {
    expect(belongingMarks(inputs(null))).toEqual([]);
  });
});

describe("belonging view", () => {
  const view = { height: 100, pixelsPerUnit: 2, width: 100, x: 100, y: -40 };

  it("lets a matched region join and lead the layer, and unpins a group whose file left the view", () => {
    const matches = region({ id: "evidence:matches" });
    const responsibility = {
      links: [],
      members: ["inside"],
      pathDisagreement: [],
      related: [],
      territoryId: "island",
      totalLinks: 0,
      unresolved: [],
    };
    const joined = belongingView({
      belonging: { pinned: "region", regions: [region()], territory: island },
      fileId: "inside",
      matches,
      responsibility,
      selected: "island",
      territories: [island],
      view,
    });
    expect(joined.belonging?.regions.at(-1)).toBe(matches);
    expect(joined.activeRegion).toBe(matches);
    expect(joined.baselineRegionId).toBe("region");
    expect(joined.evidenceFiles).toEqual(new Set(["inside"]));
    const unpinned = belongingView({
      belonging: { pinned: "region", regions: [region()], territory: island },
      fileId: "shore",
      matches: undefined,
      responsibility: null,
      selected: "island",
      territories: [island],
      view: { ...view, width: 20 },
    });
    expect(unpinned.belonging?.pinned).toBeUndefined();
    expect(unpinned.activeRegion).toBeUndefined();
    expect(unpinned.districtFloor).toBe(0);
  });
});
