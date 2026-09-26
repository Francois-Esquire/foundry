import { describe, expect, it, vi } from "vitest";
import { memberContours } from "../../src/web/belonging";
import { paintMap } from "../../src/web/paint-map";
import type { ResponsibilityOverlay } from "../../src/web/responsibility-focus";
import type { AtlasData, Territory } from "../../src/web/types";

const territory: Territory = {
  analyzed: true,
  coast: [],
  color: "#abcdef",
  files: ["one", "two"].map((id, index) => ({
    directory: "src",
    id,
    incoming: 0,
    kind: "source",
    outgoing: 0,
    path: `src/${id}.ts`,
    x: index * 60 - 30,
    y: 0,
  })),
  hills: [],
  id: "island",
  label: "Island",
  neighborhoods: [
    {
      id: "district",
      imports: 1,
      label: "District",
      members: ["one", "two"],
      sharedConcepts: 1,
    },
  ],
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
  routes: [{ from: "island", sharedConcepts: 0, to: "other", weight: 1 }],
  territories: [
    territory,
    {
      ...territory,
      files: [],
      id: "other",
      label: "Other",
      neighborhoods: [],
      x: 200,
    },
  ],
  width: 500,
};

function canvasFixture() {
  const ctx = {
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
  return {
    canvas: {
      getContext: () => ctx,
      height: 500,
      width: 500,
    } as unknown as HTMLCanvasElement,
    ctx,
  };
}

describe("map detail drawing", () => {
  it("shows quiet specks at region scale and full files without island selection", () => {
    const { canvas, ctx } = canvasFixture();
    const alphas: number[] = [];
    ctx.fillRect.mockImplementation(() => alphas.push(ctx.globalAlpha));
    paintMap(canvas, data, null, null, "ink", {
      height: 500,
      pixelsPerUnit: 2,
      width: 500,
      x: 0,
      y: 0,
    });
    expect(alphas).toContain(0.2);
    alphas.length = 0;
    paintMap(canvas, data, null, null, "ink", {
      height: 500,
      pixelsPerUnit: 5,
      width: 500,
      x: 0,
      y: 0,
    });
    expect(alphas).toContain(1);
  });
  it("draws Belonging regions at island scale without selection", () => {
    const { canvas, ctx } = canvasFixture();
    paintMap(
      canvas,
      data,
      null,
      null,
      "ink",
      { height: 500, pixelsPerUnit: 2, width: 500, x: 0, y: 0 },
      undefined,
      [],
      null,
      false,
      {
        regions: [
          {
            color: "#678",
            id: "region",
            label: "Region",
            members: territory.files,
            polygons: memberContours(territory.files),
            uncertain: false,
          },
        ],
        territory,
      }
    );
    expect(ctx.clip).toHaveBeenCalled();
  });
  it("retains parent labels through composition and leaves neighboring anchors passive", () => {
    const { canvas } = canvasFixture();
    const parent = {
      anchor: territory.files[1],
      children: ["child"],
      color: "#678",
      id: "composite",
      label: "Parent",
      members: territory.files,
      polygons: memberContours(territory.files),
      uncertain: false,
    };
    const neighbor = { ...parent, id: "neighbor", label: "Neighbor" };
    const labels = paintMap(
      canvas,
      data,
      "island",
      "one",
      "ink",
      { height: 500, pixelsPerUnit: 8, width: 500, x: 0, y: 0 },
      undefined,
      [],
      {
        composition: {
          active: [],
          fileId: "one",
          marks: [{ group: "group", id: "symbol", x: 2, y: 0 }],
          names: { symbol: "Symbol" },
        },
        links: [],
        members: ["one"],
        pathDisagreement: [],
        related: [],
        territoryId: "island",
        totalLinks: 0,
        unresolved: [],
      },
      false,
      {
        files: territory.files.slice(0, 1),
        parents: [parent],
        regions: [],
        surroundings: [neighbor],
        territory,
      }
    );
    expect(labels.some((label) => label.compositeId === "composite")).toBe(
      true
    );
    expect(labels.some((label) => label.compositeId === "neighbor")).toBe(
      false
    );
    expect(labels.some((label) => label.file?.id === "one")).toBe(true);
  });
  it("clips belonging pigment and replaces old district labels with exact group identity", () => {
    const { canvas, ctx } = canvasFixture();
    const region = {
      color: "#687",
      id: "belonging",
      label: "Responsibility",
      members: territory.files.slice(0, 1),
      polygons: memberContours(territory.files.slice(0, 1)),
      uncertain: false,
    };
    const labels = paintMap(
      canvas,
      data,
      "island",
      null,
      "ink",
      { height: 500, pixelsPerUnit: 2, width: 500, x: 0, y: 0 },
      undefined,
      [],
      null,
      false,
      { pinned: region.id, regions: [region], territory }
    );
    expect(ctx.clip).toHaveBeenCalledWith("evenodd");
    expect(labels.some((label) => label.regionId === region.id)).toBe(true);
    expect(labels.some((label) => label.neighborhoodId)).toBe(false);
    expect(
      ctx.strokeRect.mock.calls.filter((args) => args[2] === 3.5 / 2)
    ).toHaveLength(1);
    const closeLabels = paintMap(
      canvas,
      data,
      "island",
      null,
      "ink",
      { height: 500, pixelsPerUnit: 5, width: 500, x: 0, y: 0 },
      undefined,
      [],
      null,
      false,
      { pinned: region.id, regions: [region], territory }
    );
    expect(closeLabels.some((label) => label.file?.id === "two")).toBe(false);
  });
  it("retires district and neighboring file labels as composition becomes dominant", () => {
    const { canvas } = canvasFixture();
    const view = { height: 500, pixelsPerUnit: 2, width: 500, x: 0, y: 0 };
    const districts = paintMap(canvas, data, "island", null, "ink", view);
    expect(districts.some((label) => label.neighborhoodId === "district")).toBe(
      true
    );
    expect(districts.some((label) => label.file)).toBe(false);
    const files = paintMap(canvas, data, "island", null, "ink", {
      ...view,
      pixelsPerUnit: 5,
    });
    expect(files.filter((label) => label.file)).toHaveLength(2);
    expect(files.some((label) => label.neighborhoodId)).toBe(false);
    const focused = paintMap(canvas, data, "island", "one", "ink", {
      ...view,
      pixelsPerUnit: 5,
    });
    expect(
      focused.filter((label) => label.file).map((label) => label.file?.id)
    ).toEqual(["one"]);
    const overlay: ResponsibilityOverlay = {
      composition: {
        active: [],
        fileId: "one",
        marks: [{ group: "group", id: "symbol", x: 2, y: 0 }],
        names: { symbol: "Symbol" },
      },
      links: [],
      members: ["one"],
      pathDisagreement: [],
      related: [],
      territoryId: "island",
      totalLinks: 0,
      unresolved: [],
    };
    const composition = paintMap(
      canvas,
      data,
      "island",
      "one",
      "ink",
      { ...view, pixelsPerUnit: 8 },
      undefined,
      [],
      overlay
    );
    expect(
      composition.filter((label) => label.file).map((label) => label.file?.id)
    ).toEqual(["one"]);
    expect(composition.some((label) => label.neighborhoodId)).toBe(false);
    const elsewhere = paintMap(
      canvas,
      data,
      "island",
      "one",
      "ink",
      { ...view, pixelsPerUnit: 8, width: 40, x: 30 },
      undefined,
      [],
      overlay
    );
    expect(
      elsewhere.filter((label) => label.file).map((label) => label.file?.id)
    ).toEqual(["two"]);
  });
  it("limits relationship labels to evidence and keeps a bounded amount of ink", () => {
    const { canvas } = canvasFixture();
    const source = territory.files[0];
    if (!source) {
      throw new Error("Missing fixture file");
    }
    const populated = {
      ...territory,
      files: Array.from({ length: 80 }, (_, index) => ({
        ...source,
        id: `file:${index}`,
        path: `src/file-${index}.ts`,
        x: (index % 10) * 15 - 70,
        y: Math.floor(index / 10) * 15 - 55,
      })),
    };
    const view = { height: 140, pixelsPerUnit: 5, width: 180, x: 0, y: 0 };
    const crowded = paintMap(
      canvas,
      { ...data, territories: [populated] },
      "island",
      null,
      "ink",
      view
    );
    expect(crowded.filter((label) => label.file).length).toBeLessThanOrEqual(
      15
    );
    const focused = paintMap(
      canvas,
      { ...data, territories: [populated] },
      "island",
      null,
      "ink",
      view,
      undefined,
      [],
      {
        links: [],
        members: ["file:0"],
        pathDisagreement: [],
        related: [],
        territoryId: "island",
        totalLinks: 0,
        unresolved: [],
      }
    );
    expect(
      focused.filter((label) => label.file).map((label) => label.file?.id)
    ).toEqual(["file:0"]);
  });
});
