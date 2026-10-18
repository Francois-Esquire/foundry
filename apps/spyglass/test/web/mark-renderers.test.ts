import { Mesh } from "three";
import { describe, expect, it } from "vitest";
import type { Territory } from "../../src/web/data/types";
import { inkAlpha, inks } from "../../src/web/ladder/ink-ladder";
import type { Fill, Glyph, Stroke } from "../../src/web/layout/marks";
import { terrainCell } from "../../src/web/layout/terrain-field";
import { islandTop } from "../../src/web/layout/terrain-height";
import {
  densify,
  flatMarkHeight,
  polygonGeometry,
  polylineVertices,
} from "../../src/web/scene/marks/drape";
import { batchFills, createFillBatch } from "../../src/web/scene/marks/fills";
import {
  batchGlyphs,
  createGlyphBatch,
} from "../../src/web/scene/marks/glyphs";
import {
  type MarkFrame,
  markLayerNode,
  markRenderOrder,
} from "../../src/web/scene/marks/mark-layer";
import {
  batchStrokes,
  createStrokeBatch,
  strokeKeyText,
} from "../../src/web/scene/marks/strokes";

const square: [number, number][] = [
  [-40, -40],
  [40, -40],
  [40, 40],
  [-40, 40],
  [-40, -40],
];

const island: Territory = {
  analyzed: true,
  coast: [[square]],
  fileRoles: undefined,
  files: [],
  folder: "",
  highFanInCutoff: 0,
  hills: [],
  id: "island",
  label: "Island",
  radius: 40,
  responsibilityGroups: undefined,
  shallows: [],
  x: 200,
  y: 100,
};

const stroke = (overrides: Partial<Stroke> = {}): Stroke => ({
  alpha: 1,
  colour: inks.grid,
  kind: "stroke",
  points: [0, 0, 10, 0],
  width: 1,
  ...overrides,
});

describe("drape", () => {
  it("cuts a polyline so no segment exceeds the terrain cell, keeping its ends", () => {
    const dense = densify([0, 0, 10, 0, 10, 1]);
    expect(dense.slice(0, 2)).toEqual([0, 0]);
    expect(dense.slice(-2)).toEqual([10, 1]);
    for (let i = 2; i + 1 < dense.length; i += 2) {
      const length = Math.hypot(
        (dense[i] ?? 0) - (dense[i - 2] ?? 0),
        (dense[i + 1] ?? 0) - (dense[i - 1] ?? 0)
      );
      expect(length).toBeLessThanOrEqual(terrainCell + 1e-9);
    }
    expect(dense).toHaveLength(2 * (1 + 4 + 1));
  });

  it("lays flat marks just above the paper and lifts draped ones onto the island", () => {
    const flat = polylineVertices([0, 0, 10, 0], undefined);
    expect([...flat].map((value) => Math.round(value * 1e4) / 1e4 + 0)).toEqual(
      [0, 0, 0.42, 10, 0, 0.42]
    );
    const inland = polylineVertices([180, 100, 220, 100], island);
    expect(inland.length / 3).toBe(1 + Math.ceil(40 / terrainCell));
    for (let v = 0; v + 2 < inland.length; v += 3) {
      expect(inland[v + 1]).toBe(-100);
      expect(inland[v + 2]).toBeGreaterThan(islandTop);
    }
    // The middle of the island stands higher than its shore.
    const middle = inland[Math.floor(inland.length / 6) * 3 + 2] ?? 0;
    expect(middle).toBeGreaterThan(inland[2] ?? 0);
  });

  it("tessellates a draped polygon to the terrain cell and lifts every vertex", () => {
    const polygon: [number, number][][] = [
      [
        [180, 80],
        [220, 80],
        [220, 120],
        [180, 120],
        [180, 80],
      ],
    ];
    const flat = polygonGeometry(polygon, undefined);
    expect(flat.getAttribute("position").count).toBe(4);
    expect(flat.getAttribute("position").getZ(0)).toBeCloseTo(flatMarkHeight);
    const draped = polygonGeometry(polygon, island);
    const positions = draped.getAttribute("position");
    expect(positions.count).toBeGreaterThan(4);
    for (let i = 0; i < positions.count; i += 1) {
      expect(positions.getZ(i)).toBeGreaterThan(islandTop);
      expect(positions.getY(i)).toBeLessThanOrEqual(-80);
      expect(positions.getY(i)).toBeGreaterThanOrEqual(-120);
    }
  });
});

describe("stroke batches", () => {
  const minor = inkAlpha.gridMinor;

  it("groups by width, dash, cap, plane and the alpha's identity, keeping first-seen order", () => {
    const batches = batchStrokes([
      stroke({ alpha: minor, width: 0.5 }),
      stroke({ alpha: 0.17, colour: inks.ripple, width: 0.7 }),
      stroke({ alpha: minor, colour: inks.ripple, width: 0.5 }),
      stroke({ alpha: 0.17, on: island, width: 0.7 }),
      stroke({ alpha: 0.17, dash: [4, 2], width: 0.7 }),
      stroke({ alpha: 0.17, cap: "butt", width: 0.7 }),
      stroke({ alpha: (pixels) => pixels, width: 0.5 }),
    ]);
    expect(batches.map((batch) => batch.strokes.length)).toEqual([
      2, 1, 1, 1, 1, 1,
    ]);
    expect(batches.map((batch) => strokeKeyText(batch.key))).toEqual([
      "0.5|solid|round|flat|fn0",
      "0.7|solid|round|flat|=0.17",
      "0.7|solid|round|draped|=0.17",
      "0.7|4/2|round|flat|=0.17",
      "0.7|solid|butt|flat|=0.17",
      "0.5|solid|round|flat|fn1",
    ]);
  });

  it("builds one line object per batch with a segment per polyline edge, in device pixels", () => {
    const [batch] = batchStrokes([
      stroke({ points: [0, 0, 10, 0, 10, 10] }),
      stroke({ colour: inks.ripple, points: [0, 0, 5, 5] }),
    ]);
    if (!batch) {
      throw new Error("expected a batch");
    }
    const built = createStrokeBatch(batch, markRenderOrder(0, 0));
    expect(built.segments).toBe(3);
    expect(built.object.geometry.attributes.instanceStart?.count).toBe(3);
    expect(built.object.renderOrder).toBe(0.001);
    expect(built.object.material.depthTest).toBe(true);
    expect(built.object.material.transparent).toBe(true);
    built.setView(2, 2);
    // A one-pixel stroke on a two-pixel device, plus the feather pixel.
    expect(built.object.material.linewidth).toBe(3);
    expect(built.object.material.opacity).toBe(1);
    // Square ends: the dash path with no gap, so joints never bead.
    expect(built.object.material.dashed).toBe(true);
    expect(built.object.material.gapSize).toBe(0);
    expect(built.object.material.dashSize).toBeGreaterThan(1e6);
    built.dispose();
  });

  it("scales dashes to screen pixels at the zoom, and draws draped strokes in order over the land", () => {
    const [dashed] = batchStrokes([
      stroke({ alpha: minor, dash: [6, 3], on: island }),
    ]);
    if (!dashed) {
      throw new Error("expected a batch");
    }
    const built = createStrokeBatch(dashed, markRenderOrder(2, 1));
    expect(built.object.material.depthTest).toBe(false);
    built.setView(4, 1);
    expect(built.object.material.scale).toBe(4);
    expect(built.object.material.dashSize).toBe(6);
    expect(built.object.material.gapSize).toBe(3);
    expect(built.object.material.opacity).toBeCloseTo(minor(4));
    expect(built.object.renderOrder).toBeCloseTo(0.001 * (1 + 64 + 1));
    built.dispose();
  });
});

describe("fill and glyph batches", () => {
  const polygon: Fill["polygon"] = [
    [
      [190, 90],
      [210, 90],
      [210, 110],
      [190, 110],
      [190, 90],
    ],
  ];

  it("merges fills of one alpha and plane into a mesh with per-vertex ink", () => {
    const fills: Fill[] = [
      { alpha: 0.5, colour: inks.grid, kind: "fill", on: island, polygon },
      { alpha: 0.5, colour: inks.ripple, kind: "fill", on: island, polygon },
      { alpha: 0.5, colour: inks.grid, kind: "fill", polygon },
    ];
    const batches = batchFills(fills);
    expect(batches.map((batch) => batch.fills.length)).toEqual([2, 1]);
    const [draped] = batches;
    if (!draped) {
      throw new Error("expected a batch");
    }
    const built = createFillBatch(draped, markRenderOrder(1, 0));
    expect(built.object).toBeInstanceOf(Mesh);
    expect(built.vertices).toBeGreaterThan(8);
    expect(built.object.geometry.getAttribute("color").count).toBe(
      built.vertices
    );
    expect(built.object.material.depthTest).toBe(false);
    built.setView(1);
    expect(built.object.material.opacity).toBe(0.5);
    built.dispose();
  });

  it("instances glyphs by shape, sized in screen pixels", () => {
    const glyphs: Glyph[] = [
      {
        alpha: 1,
        colour: inks.grid,
        kind: "glyph",
        shape: "dot",
        size: 4,
        x: 0,
        y: 0,
      },
      {
        alpha: 1,
        colour: inks.grid,
        kind: "glyph",
        shape: "ring",
        size: 6,
        x: 1,
        y: 1,
      },
      {
        alpha: 1,
        colour: inks.ripple,
        kind: "glyph",
        shape: "dot",
        size: 4,
        x: 2,
        y: 2,
      },
    ];
    const batches = batchGlyphs(glyphs);
    expect(batches.map((batch) => batch.glyphs.length)).toEqual([2, 1]);
    const [dots] = batches;
    if (!dots) {
      throw new Error("expected a batch");
    }
    const built = createGlyphBatch(dots, markRenderOrder(0, 0));
    expect(built.object.geometry.getAttribute("glyphSize").count).toBe(2);
    expect(
      built.object.geometry.getAttribute("glyphCentre").getZ(0)
    ).toBeCloseTo(flatMarkHeight);
    built.setView(2);
    expect(built.object.material.opacity).toBe(1);
    built.dispose();
  });
});

describe("hollow and upright glyphs", () => {
  it("keeps a frame's band at its weight and stands upright batches apart, with each glyph's offset", () => {
    const frame = (overrides: Partial<Glyph>): Glyph => ({
      alpha: 1,
      colour: inks.domain,
      kind: "glyph",
      shape: "frame",
      size: 9,
      weight: 1,
      x: 0,
      y: 0,
      ...overrides,
    });
    const batches = batchGlyphs([
      frame({}),
      frame({ size: 15.5, upright: true, weight: 2.5 }),
      frame({ offset: [0, -9], x: 5 }),
    ]);
    expect(batches.map((batch) => batch.glyphs.length)).toEqual([2, 1]);
    const [flat] = batches;
    if (!flat) {
      throw new Error("expected a batch");
    }
    const built = createGlyphBatch(flat, markRenderOrder(0, 0));
    const { geometry } = built.object;
    // Four outer corners stay put; four inner ones draw in by the weight.
    const inset = geometry.getAttribute("inset");
    expect(inset.count).toBe(8);
    expect([inset.getX(0), inset.getY(0)]).toEqual([0, 0]);
    expect([inset.getX(4), inset.getY(4)]).toEqual([1, 1]);
    expect(geometry.getAttribute("glyphWeight").getX(0)).toBe(1);
    expect(geometry.getAttribute("glyphOffset").getY(1)).toBe(-9);
    expect(geometry.index?.count).toBe(24);
    built.dispose();
  });
});

describe("mark layer node", () => {
  it("rebuilds only when the layer answers with a new array, and times the rebuild", () => {
    let marks: Stroke[] = [stroke()];
    const node = markLayerNode(
      { id: "test", marks: () => marks },
      {
        chart: { ripples: [], sea: { height: 1, width: 1 } },
        order: 0,
        pixelRatio: () => 1,
      }
    );
    const view = { height: 100, pixelsPerUnit: 2, width: 100, x: 0, y: 0 };
    const state = {} as MarkFrame["state"];
    node.update?.(view, state);
    node.update?.(view, state);
    expect(node.stats()).toMatchObject({
      id: "test",
      marks: 1,
      rebuilds: 1,
      segments: 1,
      vertices: 0,
    });
    expect(node.group.children).toHaveLength(1);
    marks = [stroke(), stroke({ width: 2 })];
    node.update?.(view, state);
    expect(node.stats()).toMatchObject({ marks: 2, rebuilds: 2, segments: 2 });
    expect(node.group.children).toHaveLength(2);
    expect(node.stats().lastRebuildMs).toBeGreaterThanOrEqual(0);
    node.dispose();
    expect(node.group.children).toHaveLength(0);
  });
});
