import { Mesh, MeshBasicMaterial, Object3D } from "three";
import { LineSegments2 } from "three/addons/lines/webgpu/LineSegments2.js";
import { describe, expect, it } from "vitest";
import type {
  Polygon,
  SpyglassFile,
  Territory,
} from "../../src/web/data/types";
import { departureRing, inkAlpha, inks } from "../../src/web/ladder/ink-ladder";
import type {
  Fill,
  Glyph,
  GlyphShape,
  Stroke,
} from "../../src/web/layout/marks";
import { responsibilityMarks } from "../../src/web/layout/responsibility-marks";
import { terrainCell } from "../../src/web/layout/terrain-field";
import {
  flatMarkHeight,
  islandTop,
  type ReliefOf,
} from "../../src/web/layout/terrain-height";
import {
  groupBy,
  markMaterialOptions,
  placeObject,
  zoomKeyText,
} from "../../src/web/scene/marks/batch";
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
import { createReliefLayer } from "../../src/web/scene/relief-layer";
import { createViewState } from "../../src/web/scene/view-state";
import { defaultChartSettings } from "../../src/web/settings/chart-settings";
import { ownRelief, twoIslands } from "../helpers/island-fixture";

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
    const flat = polylineVertices([0, 0, 10, 0], undefined, ownRelief);
    expect([...flat].map((value) => Math.round(value * 1e4) / 1e4 + 0)).toEqual(
      [0, 0, 0.42, 10, 0, 0.42]
    );
    const inland = polylineVertices([180, 100, 220, 100], island, ownRelief);
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
    const vertices = polylineVertices(points, "chart", ownRelief, [island]);
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
    expect(polylineVertices(points, "chart", ownRelief, islands)).toBe(
      polylineVertices(points, "chart", ownRelief, islands)
    );
    expect(polylineVertices(points, "chart", ownRelief, [island])).not.toBe(
      polylineVertices(points, "chart", ownRelief, islands)
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
    const flat = polygonGeometry(polygon, undefined, ownRelief);
    expect(flat.getAttribute("position").count).toBe(4);
    expect(flat.getAttribute("position").getZ(0)).toBeCloseTo(flatMarkHeight);
    const draped = polygonGeometry(polygon, island, ownRelief);
    const positions = draped.getAttribute("position");
    expect(positions.count).toBeGreaterThan(4);
    for (let i = 0; i < positions.count; i += 1) {
      expect(positions.getZ(i)).toBeGreaterThan(islandTop);
      expect(positions.getY(i)).toBeLessThanOrEqual(-80);
      expect(positions.getY(i)).toBeGreaterThanOrEqual(-120);
    }
  });

  /** A high fan-in file west of the island's centre: the one summit of its field. */
  const summit: SpyglassFile = {
    directory: "src",
    highFanIn: true,
    id: "summit",
    incoming: 0,
    internalFanIn: 20,
    kind: "source",
    outgoing: 0,
    path: "src/summit.ts",
    x: -20,
    y: 0,
  };
  const peaked: Territory = {
    ...island,
    files: [summit],
    highFanInCutoff: 3,
    id: "peaked",
  };
  /** The island as a relayout leaves it: the same coast, the summit moved east. */
  const relaid: Territory = { ...peaked, files: [{ ...summit, x: 20 }] };
  /** A line west to east across the island, through both summit positions. */
  const across = [170, 100, 230, 100];
  const plot: [number, number][][] = [
    [
      [185, 85],
      [215, 85],
      [215, 115],
      [185, 115],
      [185, 85],
    ],
  ];
  const heights = (vertices: Float32Array) =>
    [...vertices].filter((_, i) => i % 3 === 2);
  const polygonHeights = (
    polygon: Polygon,
    on: Territory,
    reliefOf: ReliefOf
  ) => {
    const positions = polygonGeometry(polygon, on, reliefOf).getAttribute(
      "position"
    );
    return Array.from({ length: positions.count }, (_, i) => positions.getZ(i));
  };

  it("drapes a relaid island on the relief as drawn, the field its relief was built from, not the moved summit's", () => {
    const relief = createReliefLayer(
      { ...twoIslands, territories: [peaked] },
      new MeshBasicMaterial()
    );
    // As its own relief, the relaid island drapes to other heights: the
    // summit moved, so the field did.
    const drawn = polylineVertices(across, peaked, ownRelief);
    expect(heights(polylineVertices(across, relaid, ownRelief))).not.toEqual(
      heights(drawn)
    );
    const plotDrawn = polygonHeights(plot, peaked, ownRelief);
    expect(polygonHeights(plot, relaid, ownRelief)).not.toEqual(plotDrawn);
    // Through the relief, it drapes on the field drawn, and shares the drape.
    expect(polylineVertices(across, relaid, relief.islandOf)).toBe(drawn);
    expect(polygonHeights(plot, relaid, relief.islandOf)).toEqual(plotDrawn);
    expect(polygonGeometry(plot, relaid, relief.islandOf)).toBe(
      polygonGeometry(plot, peaked, ownRelief)
    );
    // A stroke on the chart finds the relaid island under it, and the same field.
    expect(
      heights(polylineVertices(across, "chart", relief.islandOf, [relaid]))
    ).toEqual(heights(drawn));
    relief.dispose();
  });

  it("keeps a drape by the island whose relief it lies on, so two islands never share one", () => {
    const lowland: Territory = { ...island, id: "lowland" };
    const onPeaked = polylineVertices(across, peaked, ownRelief);
    expect(polylineVertices(across, peaked, ownRelief)).toBe(onPeaked);
    const onLowland = polylineVertices(across, lowland, ownRelief);
    expect(onLowland).not.toBe(onPeaked);
    expect(heights(onLowland)).not.toEqual(heights(onPeaked));
    const plotOnPeaked = polygonGeometry(plot, peaked, ownRelief);
    expect(polygonGeometry(plot, peaked, ownRelief)).toBe(plotOnPeaked);
    expect(polygonGeometry(plot, lowland, ownRelief)).not.toBe(plotOnPeaked);
    expect(polygonHeights(plot, lowland, ownRelief)).not.toEqual(
      polygonHeights(plot, peaked, ownRelief)
    );
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
    const built = createStrokeBatch(batch, markRenderOrder(0, 0, 1), ownRelief);
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
    const built = createStrokeBatch(
      batch,
      markRenderOrder(0, 0, 1),
      ownRelief,
      [island]
    );
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
    const built = createStrokeBatch(
      dashed,
      markRenderOrder(2, 1, 2),
      ownRelief
    );
    expect(built.object.material.depthTest).toBe(false);
    built.setView(4, 1);
    expect(built.object.material.scale).toBe(4);
    expect(built.object.material.dashSize).toBe(6);
    expect(built.object.material.gapSize).toBe(3);
    expect(built.object.material.opacity).toBeCloseTo(minor(4));
    expect(built.object.renderOrder).toBeCloseTo(0.001 * (1 + 2 + 1 / 2));
    built.dispose();
  });

  it("draws a dash shorter than the stroke's width the width long, keeping the period, as a canvas dot was", () => {
    const [dotted] = batchStrokes([stroke({ dash: [0.1, 4], width: 1.4 })]);
    if (!dotted) {
      throw new Error("expected a batch");
    }
    const built = createStrokeBatch(
      dotted,
      markRenderOrder(0, 0, 1),
      ownRelief
    );
    built.setView(2, 2);
    expect(built.object.material.dashSize).toBeCloseTo(2.8);
    expect(built.object.material.gapSize).toBeCloseTo(5.4);
    expect(built.object.children).toHaveLength(0);
    built.dispose();
  });

  it("draws a dash-dot stroke as two passes over one geometry: the dashes, and the dots in the gaps", () => {
    const [dashDot] = batchStrokes([
      stroke({ dash: [8, 3, 1, 3], width: 1.6 }),
    ]);
    if (!dashDot) {
      throw new Error("expected a batch");
    }
    expect(strokeKeyText(dashDot.key)).toBe("1.6|8/3/1/3|round|flat|=1");
    const built = createStrokeBatch(
      dashDot,
      markRenderOrder(0, 0, 1),
      ownRelief
    );
    built.setView(2, 1);
    const dashes = built.object.material;
    expect(dashes.dashSize).toBe(8);
    expect(dashes.gapSize).toBe(7);
    expect(dashes.dashOffset).toBe(15);
    const [dots] = built.object.children;
    if (!(dots instanceof LineSegments2)) {
      throw new Error("expected the dots' pass");
    }
    expect(dots.geometry).toBe(built.object.geometry);
    // The dot is the width long, starting 11 pixels into the period.
    expect(dots.material.dashSize).toBeCloseTo(1.6);
    expect(dots.material.gapSize).toBeCloseTo(13.4);
    expect(dots.material.dashOffset).toBe(4);
    expect(dots.renderOrder).toBe(built.object.renderOrder);
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
    const built = createFillBatch(draped, markRenderOrder(1, 0, 1), ownRelief);
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
    const built = createGlyphBatch(dots, markRenderOrder(0, 0, 1), ownRelief);
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
    const built = createGlyphBatch(flat, markRenderOrder(0, 0, 1), ownRelief);
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
    const built = createGlyphBatch(shared, markRenderOrder(0, 0, 1), ownRelief);
    // The instance carries a unit size; the batch scales it at the zoom.
    expect(built.object.geometry.getAttribute("glyphSize").getX(0)).toBe(1);
    built.setView(2);
    built.dispose();
    const named = createGlyphBatch(fixed, markRenderOrder(0, 1, 2), ownRelief);
    expect(named.object.geometry.getAttribute("glyphSize").getX(0)).toBe(4);
    named.dispose();
  });

  /** A shape's vertices as the glyph batch builds them: each point and how far its band draws it out. */
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
    const built = createGlyphBatch(batch, markRenderOrder(0, 0, 1), ownRelief);
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

  it("builds the banded shapes with their band astride the edge, and the file shapes in the pen's proportions", () => {
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

  it("opens the departure ring at the north by the ladder's notch, and the plug closes exactly that gap", () => {
    const angleOf = (point: { x: number; y: number }) =>
      Math.atan2(point.y, point.x);
    const ring = shapeOf("notchedRing");
    const plug = shapeOf("notchPlug");
    for (const shape of [ring, plug]) {
      for (const point of shape.points) {
        expect(Math.hypot(point.x, point.y)).toBeCloseTo(0.5);
        expect(point.inset).toBeCloseTo(0.5);
      }
    }
    const half = departureRing.notch / 2;
    // The ring runs from the notch's eastern edge round to its western one.
    expect(angleOf(ring.points[0] ?? { x: 0, y: 0 })).toBeCloseTo(
      Math.PI / 2 + half
    );
    expect(angleOf(ring.points.at(-1) ?? { x: 0, y: 0 })).toBeCloseTo(
      Math.PI / 2 - half
    );
    expect(angleOf(plug.points[0] ?? { x: 0, y: 0 })).toBeCloseTo(
      Math.PI / 2 - half
    );
    expect(angleOf(plug.points.at(-1) ?? { x: 0, y: 0 })).toBeCloseTo(
      Math.PI / 2 + half
    );
    // Nothing of the ring lies within the notch.
    for (const point of ring.points) {
      const away = Math.abs(angleOf(point) - Math.PI / 2);
      expect(away).toBeGreaterThanOrEqual(half - 1e-9);
    }
  });
});

describe("mark layer node", () => {
  it("draws a trace's tether below its paper veil and its outline above it", () => {
    const territory = {
      ...island,
      files: twoIslands.territories[0]?.files ?? [],
    };
    const marks = responsibilityMarks({
      overlay: {
        composition: {
          active: ["declaration"],
          fileId: "one",
          marks: [{ group: "g", id: "declaration", x: 2, y: 0 }],
          names: {},
          stationary: ["declaration"],
        },
        links: [],
        members: [],
        pathDisagreement: [],
        related: ["one"],
        territoryId: territory.id,
        totalLinks: 0,
        trace: {
          blockers: [],
          marks: [{ group: "g", id: "declaration", x: 8, y: 0 }],
          progress: 0.5,
        },
        unresolved: [],
      },
      pixels: 8,
      territory,
    });
    const node = markLayerNode(
      { id: "responsibility", marks: () => marks },
      {
        chart: {
          boundaries: {
            clearance: [],
            coasts: [],
            depths: [],
            footprint: [],
            foundations: [],
            groups: [],
            outer: [],
            pockets: [],
          },
          ripples: [],
          sea: { height: 500, width: 500 },
          topography: [],
        },
        order: 0,
        pixelRatio: () => 1,
        reliefOf: ownRelief,
      }
    );
    const state = createViewState(
      { ...twoIslands, territories: [territory] },
      defaultChartSettings
    );
    try {
      node.update?.(
        { height: 100, pixelsPerUnit: 8, width: 100, x: 0, y: 0 },
        state,
        0
      );
      const drawn = node.group.children.toSorted(
        (a, b) => a.renderOrder - b.renderOrder
      );
      expect(
        drawn.map((object) => {
          if (object instanceof LineSegments2) {
            return "stroke";
          }
          return object instanceof Mesh &&
            object.geometry.hasAttribute("glyphCentre")
            ? "glyph"
            : "fill";
        })
      ).toEqual(["fill", "stroke", "stroke", "fill", "stroke", "glyph"]);
    } finally {
      node.dispose();
    }
  });

  it("rebuilds only when the layer answers with a new array, and times the rebuild", () => {
    let marks: Stroke[] = [stroke()];
    const node = markLayerNode(
      { id: "test", marks: () => marks },
      {
        chart: {
          boundaries: {
            clearance: [],
            coasts: [],
            depths: [],
            footprint: [],
            foundations: [],
            groups: [],
            outer: [],
            pockets: [],
          },
          ripples: [],
          sea: { height: 1, width: 1 },
          topography: [],
        },
        order: 0,
        pixelRatio: () => 1,
        reliefOf: ownRelief,
      }
    );
    const view = { height: 100, pixelsPerUnit: 2, width: 100, x: 0, y: 0 };
    const state = {
      drawingData: { territories: [] },
    } as unknown as MarkFrame["state"];
    expect(node.kind).toBe("marks");
    node.update?.(view, state, 0);
    node.update?.(view, state, 0);
    expect(node.stats()).toMatchObject({
      batches: 1,
      marks: 1,
      rebuilds: 1,
      segments: 1,
      vertices: 0,
    });
    expect(node.stats()).not.toHaveProperty("id");
    expect(node.group.children).toHaveLength(1);
    marks = [stroke(), stroke({ width: 2 })];
    node.update?.(view, state, 0);
    expect(node.stats()).toMatchObject({
      batches: 2,
      marks: 2,
      rebuilds: 2,
      segments: 2,
    });
    expect(node.group.children).toHaveLength(2);
    expect(node.stats().rebuildMs).toBeGreaterThanOrEqual(0);
    node.dispose();
    expect(node.group.children).toHaveLength(0);
  });

  it("orders a layer's batches fills, strokes, glyphs, each under the next layer's first, however many there are", () => {
    const fill: Fill = {
      alpha: 1,
      colour: inks.grid,
      kind: "fill",
      polygon: [
        [
          [0, 0],
          [1, 0],
          [1, 1],
          [0, 0],
        ],
      ],
    };
    const glyph: Glyph = {
      alpha: 1,
      colour: inks.grid,
      kind: "glyph",
      shape: "dot",
      size: 4,
      x: 0,
      y: 0,
    };
    // Forty stroke batches: well past any fixed share of a layer's order.
    const strokes = Array.from({ length: 40 }, (_, i) =>
      stroke({ width: 1 + i / 10 })
    );
    const chart = {
      boundaries: {
        clearance: [],
        coasts: [],
        depths: [],
        footprint: [],
        foundations: [],
        groups: [],
        outer: [],
        pockets: [],
      },
      ripples: [],
      sea: { height: 1, width: 1 },
      topography: [],
    };
    const node = (order: number, marks: readonly (Fill | Glyph | Stroke)[]) =>
      markLayerNode(
        { id: `layer-${order}`, marks: () => marks },
        { chart, order, pixelRatio: () => 1, reliefOf: ownRelief }
      );
    const view = { height: 100, pixelsPerUnit: 2, width: 100, x: 0, y: 0 };
    const state = {
      drawingData: { territories: [] },
    } as unknown as MarkFrame["state"];
    const lower = node(0, [glyph, ...strokes, fill]);
    const upper = node(1, [stroke()]);
    lower.update?.(view, state, 0);
    upper.update?.(view, state, 0);
    const orders = lower.group.children.map((child) => child.renderOrder);
    expect(orders).toHaveLength(42);
    expect(lower.group.children[0]).toBeInstanceOf(Mesh);
    expect(lower.group.children[1]).toBeInstanceOf(LineSegments2);
    expect(lower.group.children.at(-1)).toBeInstanceOf(Mesh);
    for (const [i, order] of orders.entries()) {
      if (i > 0) {
        expect(order).toBeGreaterThan(orders[i - 1] ?? 0);
      }
      expect(order).toBeGreaterThan(0);
      expect(order).toBeLessThan(upper.group.children[0]?.renderOrder ?? 0);
    }
    expect(orders[0]).toBeCloseTo(markRenderOrder(0, 0, 42));
    lower.dispose();
    upper.dispose();
  });
});

describe("renderer scaffolding", () => {
  it("groups items by their key's text in first-seen order, and names a number or a shared function", () => {
    const shared = (pixels: number) => pixels;
    const other = (pixels: number) => pixels * 2;
    const groups = groupBy(
      [
        { alpha: 1, name: "a" },
        { alpha: shared, name: "b" },
        { alpha: 1, name: "c" },
        { alpha: shared, name: "d" },
        { alpha: other, name: "e" },
      ],
      (item) => item.alpha,
      zoomKeyText
    );
    expect(groups.map((group) => group.items.map((item) => item.name))).toEqual(
      [["a", "c"], ["b", "d"], ["e"]]
    );
    expect(groups[0]?.key).toBe(1);
    expect(groups[1]?.key).toBe(shared);
    expect(zoomKeyText(0.25)).toBe("=0.25");
    expect(zoomKeyText(shared)).toBe(zoomKeyText(shared));
    expect(zoomKeyText(shared).startsWith("fn")).toBe(true);
    expect(zoomKeyText(shared)).not.toBe(zoomKeyText(other));
  });

  it("sets up every mark's material and object the same way", () => {
    expect(markMaterialOptions({ draped: false })).toEqual({
      depthTest: true,
      depthWrite: false,
      transparent: true,
    });
    expect(markMaterialOptions({ draped: true }).depthTest).toBe(false);
    const object = placeObject(new Object3D(), 0.25);
    expect(object.renderOrder).toBe(0.25);
    expect(object.frustumCulled).toBe(false);
  });

  it("reports a count for every kind, zero where it does not apply", () => {
    const [fillBatch] = batchFills([
      {
        alpha: 1,
        colour: inks.grid,
        kind: "fill",
        polygon: [
          [
            [0, 0],
            [1, 0],
            [1, 1],
            [0, 0],
          ],
        ],
      },
    ]);
    const [strokeBatch] = batchStrokes([stroke()]);
    const [glyphBatch] = batchGlyphs([
      {
        alpha: 1,
        colour: inks.grid,
        kind: "glyph",
        shape: "dot",
        size: 4,
        x: 0,
        y: 0,
      },
    ]);
    if (!(fillBatch && strokeBatch && glyphBatch)) {
      throw new Error("expected a batch of each kind");
    }
    const fill = createFillBatch(
      fillBatch,
      markRenderOrder(0, 0, 3),
      ownRelief
    );
    const line = createStrokeBatch(
      strokeBatch,
      markRenderOrder(0, 1, 3),
      ownRelief
    );
    const glyph = createGlyphBatch(
      glyphBatch,
      markRenderOrder(0, 2, 3),
      ownRelief
    );
    expect([fill.segments, fill.vertices]).toEqual([0, 3]);
    expect([line.segments, line.vertices]).toEqual([1, 0]);
    expect(glyph.segments).toBe(0);
    expect(glyph.vertices).toBeGreaterThan(0);
    fill.dispose();
    line.dispose();
    glyph.dispose();
  });

  /** Every shape the vocabulary names; a shape added there must be added here, and the renderer must draw it. */
  const everyShape = [
    "closeMark",
    "cross",
    "diamond",
    "dot",
    "file",
    "frame",
    "halfDisc",
    "hoop",
    "mixed",
    "notch",
    "notchPlug",
    "notchedRing",
    "ring",
    "spring",
    "square",
    "testFile",
    "tick",
  ] as const satisfies readonly GlyphShape[];
  const _complete: Record<GlyphShape, true> = Object.fromEntries(
    everyShape.map((shape) => [shape, true])
  ) as Record<(typeof everyShape)[number], true>;

  it("draws every glyph shape as its own geometry", () => {
    const built = new Set<string>();
    for (const shape of everyShape) {
      const [batch] = batchGlyphs([
        {
          alpha: 1,
          colour: inks.grid,
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
      const glyph = createGlyphBatch(
        batch,
        markRenderOrder(0, 0, 1),
        ownRelief
      );
      const positions = glyph.object.geometry.getAttribute("position");
      expect(positions.count).toBeGreaterThan(2);
      // No two shapes share a geometry: a shape left to a fallback would.
      const signature = Array.from({ length: positions.count }, (_, i) =>
        [positions.getX(i), positions.getY(i)]
          .map((v) => v.toFixed(4))
          .join(",")
      ).join(";");
      expect(built.has(signature)).toBe(false);
      built.add(signature);
      glyph.dispose();
    }
    expect(built.size).toBe(everyShape.length);
  });
});
