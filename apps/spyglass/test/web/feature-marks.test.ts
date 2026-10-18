import { describe, expect, it } from "vitest";
import type { SpyglassFile, Territory } from "../../src/web/data/types";
import { inkStyle, inks } from "../../src/web/ladder/ink-ladder";
import { memberContours } from "../../src/web/layout/belonging";
import {
  type FeatureMarkOptions,
  naturalFeatureMarks,
} from "../../src/web/layout/feature-marks";
import { landmarkFootprint } from "../../src/web/layout/landmark-footprint";
import {
  alphaAt,
  type Glyph,
  type Mark,
  type Stroke,
} from "../../src/web/layout/marks";
import type { NaturalFeatures } from "../../src/web/layout/natural-features";
import { riverRuns } from "../../src/web/layout/river-network";

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

const commons = file("commons", -20, 0);
const junction = file("junction", 20, 0);
const lost = file("lost", 0, 20);
const features: NaturalFeatures = {
  confluences: [{ streams: 2, x: junction.x, y: junction.y }],
  landmarks: [
    {
      basis: "commons" as const,
      consumers: [],
      cutoff: 0,
      file: commons,
      footprint: landmarkFootprint(commons, 4, []),
      kind: "summit" as const,
      radius: 4,
    },
  ],
  marshes: [
    {
      drains: [{ candidate: "east", points: [lost, { x: 10, y: 10 }] }],
      region: {
        color: "#956f47",
        id: "unresolved:lost",
        label: "lost",
        members: [lost],
        polygons: memberContours([lost]),
        uncertain: true,
      },
      tufts: [
        { x: 0, y: 20 },
        { x: 2, y: 21 },
      ],
    },
  ],
  omitted: [],
  rivers: [],
  streams: [
    {
      consumerLabel: "West",
      from: "west",
      moduleEdges: 3,
      mouth: junction,
      points: [
        { x: -20, y: 0 },
        { x: 0, y: -4 },
        { x: 20, y: 0 },
      ],
      spring: commons,
      supplierLabel: "East",
      symbols: [],
      to: "east",
      width: 1,
    },
  ],
  unrouted: 0,
};

features.rivers = riverRuns(features.streams);

const on = { coast: [], id: "island", x: 100, y: 50 } as unknown as Territory;
const full = () => 1;
const marksAt = (
  pixels: number,
  streams: boolean,
  options: Partial<FeatureMarkOptions> = {}
) =>
  naturalFeatureMarks(features, {
    on,
    pixels,
    streams,
    strength: full,
    ...options,
  });
const strokesIn = (marks: readonly Mark[], colour: string) =>
  marks.filter(
    (mark): mark is Stroke => mark.kind === "stroke" && mark.colour === colour
  );

describe("natural feature marks", () => {
  it("draws the marsh's reeds and drains, and adds streams only as a layer, every mark draped on the island", () => {
    const quiet = marksAt(2, false);
    expect(strokesIn(quiet, inks.marsh).length).toBeGreaterThan(0);
    expect(strokesIn(quiet, inks.stream)).toEqual([]);
    expect(quiet.every((mark) => mark.on === on)).toBe(true);
    // Reeds are short curves flattened to a few points, in the chart's coordinates.
    const [reed] = strokesIn(quiet, inks.marsh);
    expect(reed?.points.length).toBe(10);
    expect(reed?.points[0]).toBeCloseTo(100 - 0.85);
    const flowing = marksAt(2, true);
    expect(flowing.length).toBeGreaterThan(quiet.length);
    // Bank, glint and water over one path, bank first.
    const [bank] = strokesIn(flowing, inks.streamBank);
    const [glint] = strokesIn(flowing, inks.streamGlint);
    const [water] = strokesIn(flowing, inks.stream);
    expect(bank?.points).toBe(water?.points);
    // The glint lies a hair south-east of the water, at the zoom.
    expect(glint?.points[0]).toBeCloseTo((water?.points[0] ?? 0) + 0.65 / 2);
    expect(glint?.points[1]).toBeCloseTo((water?.points[1] ?? 0) + 0.9 / 2);
    expect(bank?.width).toBeGreaterThan(glint?.width ?? 0);
    expect(glint?.width).toBeGreaterThan(water?.width ?? 0);
    expect(flowing.indexOf(bank as Mark)).toBeLessThan(
      flowing.indexOf(water as Mark)
    );
    // The same run on a rebuild is the same polyline, so its draping is kept.
    expect(strokesIn(marksAt(2, true), inks.stream)[0]?.points).toBe(
      water?.points
    );
  });

  it("thins streams to a pen line up close, and carries zero strength as zero alpha", () => {
    const water = (pixels: number) =>
      strokesIn(marksAt(pixels, true), inks.stream)[0];
    expect(water(1)?.width).toBeCloseTo(1.1);
    expect(water(10)?.width).toBeCloseTo(2.4);
    const hidden = marksAt(2, true, { strength: () => 0 });
    expect(hidden.length).toBeGreaterThan(0);
    expect(hidden.every((mark) => alphaAt(mark.alpha, 2) === 0)).toBe(true);
    // Drains and springs wait for their zoom; the marsh keeps the dash of its row.
    const drains = marksAt(4, true).filter(
      (mark): mark is Stroke =>
        mark.kind === "stroke" && mark.dash !== undefined
    );
    expect(drains).toHaveLength(1);
    expect(drains[0]?.dash).toEqual(inkStyle("marsh-drain").dash);
    expect(alphaAt(drains[0]?.alpha ?? 0, 2)).toBe(0);
    expect(alphaAt(drains[0]?.alpha ?? 0, 4)).toBeGreaterThan(0);
  });

  it("marks a spring at a source that is no landmark, and outlines the focused feature in the selection ink", () => {
    // The river springs at the commons, which is a landmark: no spring there.
    expect(marksAt(2, true).some((mark) => mark.kind === "glyph")).toBe(false);
    const unmarked = naturalFeatureMarks(
      { ...features, landmarks: [] },
      { on, pixels: 2, streams: true, strength: full }
    );
    const spring = unmarked.find(
      (mark): mark is Glyph => mark.kind === "glyph"
    );
    expect(spring).toMatchObject({ shape: "spring", x: 80, y: 50 });
    expect(alphaAt(spring?.alpha ?? 0, 1)).toBe(0);
    expect(alphaAt(spring?.alpha ?? 0, 2)).toBeCloseTo(0.75);
    const [landmark] = features.landmarks;
    const focused = marksAt(2, false, {
      focus: landmark && { kind: "landmark", landmark },
    });
    const [outline] = strokesIn(focused, inks.selection);
    expect(outline?.width).toBe(inkStyle("selection").weight);
    expect(outline?.alpha).toBe(1);
    expect(outline?.points.slice(0, 2)).toEqual(outline?.points.slice(-2));
    // A focused river shows only with the streams.
    const [river] = features.rivers;
    expect(
      strokesIn(
        marksAt(2, false, { focus: river && { kind: "river", river } }),
        inks.selection
      )
    ).toEqual([]);
    expect(
      strokesIn(
        marksAt(2, true, { focus: river && { kind: "river", river } }),
        inks.selection
      )
    ).toHaveLength(1);
  });
});
