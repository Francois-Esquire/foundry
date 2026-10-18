import { Mesh } from "three";
import { describe, expect, it } from "vitest";
import type { Territory } from "../../src/web/data/types";
import { inkAlpha, inks } from "../../src/web/ladder/ink-ladder";
import type { Fill, Glyph, Stroke } from "../../src/web/layout/marks";
import { terrainCell } from "../../src/web/layout/terrain-field";
import { flatMarkHeight, islandTop } from "../../src/web/layout/terrain-height";
import {
  densify,
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

  it("lifts a polyline draped on the chart onto the island under each vertex and the sea elsewhere, kept by its islands", () => {
    const points = [100, 100, 300, 100];
    const vertices = polylineVertices(points, "chart", [island]);
    expect(vertices.length / 3).toBe(1 + Math.ceil(200 / terrainCell));
    for (let v = 0; v + 2 < vertices.length; v += 3) {
      const x = vertices[v] ?? 0;
      const onIsland = x > 160 && x < 240;
      if (onIsland) {
        expect(vertices[v + 2]).toBeGreaterThan(islandTop);
      } else {
        expect(vertices[v + 2]).toBeCloseTo(flatMarkHeight);
      }
    }
    const islands = [island];
    expect(polylineVertices(points, "chart", islands)).toBe(
      polylineVertices(points, "chart", islands)
    );
    expect(polylineVertices(points, "chart", [island])).not.toBe(
      polylineVertices(points, "chart", islands)
    );
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

  it("draws a stroke draped on the chart as a draped batch, lifted by the islands it is built with", () => {
    const [batch] = batchStrokes([
      stroke({ on: "chart", points: [100, 100, 300, 100] }),
    ]);
    if (!batch) {
      throw new Error("expected a batch");
    }
    expect(strokeKeyText(batch.key)).toBe("1|solid|round|draped|=1");
    const built = createStrokeBatch(batch, markRenderOrder(0, 0), [island]);
    expect(built.object.material.depthTest).toBe(false);
    expect(built.segments).toBe(Math.ceil(200 / terrainCell));
    const starts = built.object.geometry.attributes.instanceStart;
    let lifted = 0;
    for (let i = 0; i < (starts?.count ?? 0); i += 1) {
      if ((starts?.getZ(i) ?? 0) > islandTop) {
        lifted += 1;
      }
    }
    expect(lifted).toBeGreaterThan(0);
    expect(lifted).toBeLessThan(starts?.count ?? 0);
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

  it("batches glyphs whose size follows the zoom by the function's identity, and sizes them through the batch", () => {
    const fileSize = (pixels: number) => Math.min(4.5, 1.8 * pixels);
    const glyph = (overrides: Partial<Glyph>): Glyph => ({
      alpha: 1,
      colour: inks.files.source,
      kind: "glyph",
      shape: "file",
      size: fileSize,
      x: 0,
      y: 0,
      ...overrides,
    });
    const batches = batchGlyphs([
      glyph({}),
      glyph({ x: 1 }),
      glyph({ size: (pixels) => pixels }),
      glyph({ size: 4 }),
    ]);
    expect(batches.map((batch) => batch.glyphs.length)).toEqual([2, 1, 1]);
    const [shared, , fixed] = batches;
    if (!(shared && fixed)) {
      throw new Error("expected batches");
    }
    expect(shared.key.size).toBe(fileSize);
    expect(fixed.key.size).toBeUndefined();
    const built = createGlyphBatch(shared, markRenderOrder(0, 0));
    // The instance carries a unit size; the batch scales it at the zoom.
    expect(built.object.geometry.getAttribute("glyphSize").getX(0)).toBe(1);
    built.setView(2);
    built.dispose();
    const named = createGlyphBatch(fixed, markRenderOrder(0, 1));
    expect(named.object.geometry.getAttribute("glyphSize").getX(0)).toBe(4);
    named.dispose();
  });

  it("builds the banded shapes with their band astride the edge, and the file shapes in the pen's proportions", () => {
    const shapeOf = (shape: Glyph["shape"]) => {
      const [batch] = batchGlyphs([
        {
          alpha: 1,
          colour: inks.files.source,
          kind: "glyph",
          shape,
          size: 10,
          weight: 1,
          x: 0,
          y: 0,
        },
      ]);
      if (!batch) {
        throw new Error("expected a batch");
      }
      const built = createGlyphBatch(batch, markRenderOrder(0, 0));
      const { geometry } = built.object;
      const positions = geometry.getAttribute("position");
      const inset = geometry.getAttribute("inset");
      const points = Array.from({ length: positions.count }, (_, i) => ({
        inset: Math.hypot(inset.getX(i), inset.getY(i)),
        x: positions.getX(i),
        y: positions.getY(i),
      }));
      built.dispose();
      return { indices: geometry.index?.count ?? 0, points };
    };
    // A hoop's vertices all lie on the unit circle, each drawn half a weight out or in.
    const hoop = shapeOf("hoop");
    for (const point of hoop.points) {
      expect(Math.hypot(point.x, point.y)).toBeCloseTo(0.5);
      expect(point.inset).toBeCloseTo(0.5);
    }
    // A plus: a fan of twelve round the centre, no triangle overlapping another.
    const cross = shapeOf("cross");
    expect(cross.points).toHaveLength(13);
    expect(cross.indices).toBe(36);
    expect(cross.points.filter((point) => point.inset === 0)).toHaveLength(1);
    // The file rect hangs south of its point: one wide, one and a half tall.
    const file = shapeOf("file");
    expect(Math.min(...file.points.map((point) => point.y))).toBe(-1);
    expect(Math.max(...file.points.map((point) => point.y))).toBe(0.5);
    expect(Math.max(...file.points.map((point) => point.x))).toBe(0.5);
    // The test rect is hollow, with a plug of four solid corners under the point.
    const test = shapeOf("testFile");
    expect(test.points).toHaveLength(12);
    expect(test.points.filter((point) => point.inset === 0)).toHaveLength(4);
    // The half disc lies south.
    const half = shapeOf("halfDisc");
    expect(half.points.every((point) => point.y <= 1e-6)).toBe(true);
    // The close mark's arcs face away from each other, set apart by the ladder's share.
    const close = shapeOf("closeMark");
    const west = close.points.filter((point) => point.x < -0.3);
    const east = close.points.filter((point) => point.x > 0.3);
    expect(west.length).toBe(east.length);
    expect(west.length).toBeGreaterThan(0);
    expect(shapeOf("notch").points.map((point) => point.x)).toEqual([
      0.25, 0.25, 0.75, 0.75,
    ]);
    expect(shapeOf("mixed").points).toHaveLength(12);
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
    const state = {
      drawingData: { territories: [] },
    } as unknown as MarkFrame["state"];
    node.update?.(view, state);
    node.update?.(view, state);
    expect(node.stats()).toMatchObject({
      batches: 1,
      id: "test",
      marks: 1,
      rebuilds: 1,
      segments: 1,
      vertices: 0,
    });
    expect(node.group.children).toHaveLength(1);
    marks = [stroke(), stroke({ width: 2 })];
    node.update?.(view, state);
    expect(node.stats()).toMatchObject({
      batches: 2,
      marks: 2,
      rebuilds: 2,
      segments: 2,
    });
    expect(node.group.children).toHaveLength(2);
    expect(node.stats().lastRebuildMs).toBeGreaterThanOrEqual(0);
    node.dispose();
    expect(node.group.children).toHaveLength(0);
  });
});
