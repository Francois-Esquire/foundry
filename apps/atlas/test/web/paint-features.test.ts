import { describe, expect, it, vi } from "vitest";
import { memberContours } from "../../src/web/belonging";
import type { NaturalFeatures } from "../../src/web/natural-features";
import { riverRuns } from "../../src/web/river-network";
import { paintNaturalFeatures } from "../../src/web/scene/paint-features";
import { paintMap } from "../../src/web/scene/paint-map";
import type { AtlasData, AtlasFile, Territory } from "../../src/web/types";

const file = (id: string, x: number, y: number): AtlasFile => ({
  directory: "src",
  id,
  incoming: 0,
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
  lakes: [{ file: commons, radius: 4 }],
  marshes: [
    {
      drains: [{ x: 10, y: 10 }],
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
      from: "west",
      moduleEdges: 3,
      mouth: junction,
      points: [
        { x: -20, y: 0 },
        { x: 0, y: -4 },
        { x: 20, y: 0 },
      ],
      spring: commons,
      to: "east",
      width: 1,
    },
  ],
  unrouted: 0,
};

features.rivers = riverRuns(features.streams);

function context() {
  return {
    arc: vi.fn(),
    beginPath: vi.fn(),
    clearRect: vi.fn(),
    clip: vi.fn(),
    closePath: vi.fn(),
    fill: vi.fn(),
    fillRect: vi.fn(),
    fillText: vi.fn(),
    globalAlpha: 1,
    lineTo: vi.fn(),
    lineWidth: 1,
    measureText: (text: string) => ({ width: text.length * 1.5 }),
    moveTo: vi.fn(),
    quadraticCurveTo: vi.fn(),
    rect: vi.fn(),
    resetTransform: vi.fn(),
    restore: vi.fn(),
    rotate: vi.fn(),
    save: vi.fn(),
    scale: vi.fn(),
    setLineDash: vi.fn(),
    stroke: vi.fn(),
    strokeRect: vi.fn(),
    strokeText: vi.fn(),
    translate: vi.fn(),
  };
}

describe("natural feature drawing", () => {
  it("always draws lakes and marsh, and streams with confluences only as a layer", () => {
    const quiet = context();
    paintNaturalFeatures(
      quiet as unknown as CanvasRenderingContext2D,
      features,
      { pixels: 2, streams: false, strength: 1 }
    );
    expect(quiet.fill).toHaveBeenCalledTimes(3);
    expect(quiet.arc).toHaveBeenCalledTimes(1);
    const flowing = context();
    paintNaturalFeatures(
      flowing as unknown as CanvasRenderingContext2D,
      features,
      { pixels: 2, streams: true, strength: 1 }
    );
    expect(flowing.arc).toHaveBeenCalledTimes(2);
    expect(flowing.stroke.mock.calls.length).toBeGreaterThan(
      quiet.stroke.mock.calls.length
    );
    expect(flowing.save).toHaveBeenCalledTimes(1);
    expect(flowing.restore).toHaveBeenCalledTimes(1);
  });

  it("thins streams to a pen line up close and paints nothing at zero strength", () => {
    const widths = (pixels: number) => {
      const ctx = context();
      const seen: number[] = [];
      ctx.stroke = vi.fn(() => {
        seen.push(ctx.lineWidth);
      });
      paintNaturalFeatures(
        ctx as unknown as CanvasRenderingContext2D,
        features,
        {
          pixels,
          streams: true,
          strength: 1,
        }
      );
      return seen;
    };
    expect(widths(1)[1]).toBe(1.1);
    expect(widths(10)[1]).toBeCloseTo(0.32);
    const hidden = context();
    paintNaturalFeatures(
      hidden as unknown as CanvasRenderingContext2D,
      features,
      { pixels: 2, streams: true, strength: 0 }
    );
    expect(hidden.save).not.toHaveBeenCalled();
  });

  it("keeps lakes through file zoom and replaces the lake file's own mark", () => {
    const territory: Territory = {
      analyzed: true,
      coast: [],
      color: "#abcdef",
      files: [commons, junction, lost],
      hills: [],
      id: "island",
      label: "Island",
      neighborhoods: [],
      radius: 80,
      shallows: [],
      x: 0,
      y: 0,
    };
    const data: AtlasData = {
      coverage: "test",
      fileEdges: [],
      generatedAt: "test",
      height: 500,
      routes: [],
      territories: [territory],
      width: 500,
    };
    const paint = (withFeatures: boolean, fileId: string | null = null) => {
      const ctx = context();
      paintMap(
        {
          getContext: () => ctx,
          height: 500,
          width: 500,
        } as unknown as HTMLCanvasElement,
        data,
        fileId && territory.id,
        fileId,
        "ink",
        { height: 500, pixelsPerUnit: 6, width: 500, x: 0, y: 0 },
        undefined,
        [],
        null,
        false,
        {
          features: withFeatures ? features : undefined,
          regions: [],
          territory,
        }
      );
      return ctx;
    };
    const plain = paint(false),
      drawn = paint(true);
    expect(drawn.fill.mock.calls.length).toBeGreaterThan(
      plain.fill.mock.calls.length
    );
    const marks = (ctx: ReturnType<typeof context>) =>
      ctx.fillRect.mock.calls.filter(([x]) => Math.abs(Number(x) + 20) < 2);
    expect(marks(plain).length).toBeGreaterThan(0);
    expect(marks(drawn)).toHaveLength(0);
    const ring = paint(true, "commons").arc.mock.calls.filter(
      ([x, y, radius]) => x === -20 && y === 0 && Number(radius) < 2
    );
    expect(ring).toHaveLength(1);
  });
});
