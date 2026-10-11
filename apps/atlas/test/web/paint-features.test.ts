import { describe, expect, it, vi } from "vitest";
import { memberContours } from "../../src/web/belonging";
import { landmarkFootprint } from "../../src/web/landmark-footprint";
import type { NaturalFeatures } from "../../src/web/natural-features";
import { riverRuns } from "../../src/web/river-network";
import { paintNaturalFeatures } from "../../src/web/scene/paint-features";
import { paintInk } from "../../src/web/scene/paint-map";
import type { AtlasData, AtlasFile, Territory } from "../../src/web/types";

const file = (id: string, x: number, y: number): AtlasFile => ({
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

function context() {
  return {
    arc: vi.fn(),
    beginPath: vi.fn(),
    clearRect: vi.fn(),
    clip: vi.fn(),
    closePath: vi.fn(),
    createLinearGradient: () => ({ addColorStop: vi.fn() }),
    ellipse: vi.fn(),
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
    strokeStyle: "",
    strokeText: vi.fn(),
    translate: vi.fn(),
  };
}

describe("natural feature drawing", () => {
  it("draws marsh ink and adds streams only as a layer", () => {
    const quiet = context();
    paintNaturalFeatures(
      quiet as unknown as CanvasRenderingContext2D,
      features,
      { pixels: 2, streams: false, strength: 1 }
    );
    expect(quiet.stroke.mock.calls.length).toBeGreaterThan(0);
    expect(quiet.fill).not.toHaveBeenCalled();

    const flowing = context();
    paintNaturalFeatures(
      flowing as unknown as CanvasRenderingContext2D,
      features,
      { pixels: 2, streams: true, strength: 1 }
    );

    expect(flowing.stroke.mock.calls.length).toBeGreaterThan(
      quiet.stroke.mock.calls.length
    );
    expect(flowing.save.mock.calls.length).toBeGreaterThan(0);
    expect(flowing.restore).toHaveBeenCalledTimes(
      flowing.save.mock.calls.length
    );
  });

  it("thins streams to a pen line up close and paints nothing at zero strength", () => {
    const widths = (pixels: number) => {
      const ctx = context();
      const seen: number[] = [];
      ctx.stroke = vi.fn(() => {
        if (ctx.strokeStyle === "#537d78") {
          seen.push(ctx.lineWidth);
        }
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
    expect(widths(1)[0]).toBe(1.1);
    expect(widths(10)[0]).toBeCloseTo(0.241);
    const hidden = context();
    paintNaturalFeatures(
      hidden as unknown as CanvasRenderingContext2D,
      features,
      { pixels: 2, streams: true, strength: 0 }
    );
    expect(hidden.save).not.toHaveBeenCalled();
  });

  it("keeps every file mark and its selection ring visible with terrain evidence", () => {
    const territory: Territory = {
      analyzed: true,
      coast: [],
      fileRoles: undefined,
      files: [commons, junction, lost],
      folder: "",
      highFanInCutoff: 0,
      hills: [],
      id: "island",
      label: "Island",
      radius: 80,
      responsibilityGroups: undefined,
      shallows: [],
      x: 0,
      y: 0,
    };
    const data: AtlasData = {
      coverage: "test",
      domains: { declared: [], placements: {} },
      fileEdges: [],
      folderCells: {},
      generatedAt: "test",
      height: 500,
      nesting: { folders: [], pathRegions: [], seams: [] },
      packageLayers: {},
      placement: { dominantShare: 0.6, labelled: [], places: {} },
      proximity: {
        apart: { coChanges: [], files: [] },
        close: [],
        labelled: [],
      },
      routes: [],
      territories: [territory],
      width: 500,
    };
    const paint = (withFeatures: boolean, fileId: string | null = null) => {
      const ctx = context();
      paintInk(
        {
          getContext: () => ctx,
          height: 500,
          width: 500,
        } as unknown as HTMLCanvasElement,
        {
          belonging: {
            features: withFeatures ? features : undefined,
            regions: [],
            territory,
          },
          data,
          fileId,
          selected: fileId && territory.id,
          view: { height: 500, pixelsPerUnit: 6, width: 500, x: 0, y: 0 },
        }
      );
      return ctx;
    };
    const plain = paint(false),
      drawn = paint(true);

    const marks = (ctx: ReturnType<typeof context>) =>
      ctx.fillRect.mock.calls.filter(([x]) => Math.abs(Number(x) + 20) < 2);
    expect(marks(plain).length).toBeGreaterThan(0);
    expect(marks(drawn)).toEqual(marks(plain));
    const ring = paint(true, "commons").arc.mock.calls.filter(
      ([x, y, radius]) => x === 0 && y === 0 && Number(radius) === 9 / 6
    );
    expect(ring).toHaveLength(1);
  });
});
