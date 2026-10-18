import { describe, expect, it, vi } from "vitest";
import { latitude } from "../../src/web/data/bindings";
import type { SpyglassData, Territory } from "../../src/web/data/types";
import { inks } from "../../src/web/ladder/ink-ladder";
import { memberContours } from "../../src/web/layout/belonging";
import { settleFiles } from "../../src/web/layout/folder-sectors";
import type { ResponsibilityOverlay } from "../../src/web/layout/responsibility-focus";
import { inkLayers } from "../../src/web/scene/ink/layers";
import { inkState } from "../../src/web/scene/ink/state";
import { paintInk } from "../../src/web/scene/paint-map";
import { paintGridReferences } from "../../src/web/scene/paint-paper";
import { singleFrame, withReadings } from "../helpers/frames";

const territory: Territory = {
  analyzed: true,
  coast: [],
  fileRoles: undefined,
  files: ["one", "two"].map((id, index) => ({
    directory: "src",
    highFanIn: false,
    id,
    incoming: 0,
    internalFanIn: 0,
    kind: "source",
    outgoing: 0,
    path: `src/${id}.ts`,
    x: index * 60 - 30,
    y: 0,
  })),
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
const data: SpyglassData = {
  coverage: "test",
  fileEdges: [],
  folderCells: {},
  frames: [singleFrame([])],
  height: 500,
  packageLayers: {},
  routes: [
    {
      consumerFiles: [],
      from: "island",
      sharedConcepts: 0,
      supplierFiles: [],
      to: "other",
      weight: 1,
    },
  ],
  territories: [
    territory,
    {
      ...territory,
      files: [],
      id: "other",
      label: "Other",
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
    createLinearGradient: () => ({ addColorStop: vi.fn() }),
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
    const labels = paintInk(canvas, {
      belonging: {
        files: territory.files.slice(0, 1),
        parents: [parent],
        regions: [],
        surroundings: [neighbor],
        territory,
      },
      data,
      fileId: "one",
      responsibility: {
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
      selected: "island",
      view: { height: 500, pixelsPerUnit: 8, width: 500, x: 0, y: 0 },
    });
    expect(labels.some((label) => label.compositeId === "composite")).toBe(
      true
    );
    expect(labels.some((label) => label.compositeId === "neighbor")).toBe(
      false
    );
    expect(labels.some((label) => label.file?.id === "one")).toBe(true);
  });
  it("replaces old district labels with exact group identity", () => {
    const { canvas } = canvasFixture();
    const region = {
      color: "#687",
      id: "belonging",
      label: "Responsibility",
      members: territory.files.slice(0, 1),
      polygons: memberContours(territory.files.slice(0, 1)),
      uncertain: false,
    };
    const labels = paintInk(canvas, {
      belonging: { pinned: region.id, regions: [region], territory },
      data,
      selected: "island",
      view: { height: 500, pixelsPerUnit: 2, width: 500, x: 0, y: 0 },
    });
    expect(labels.some((label) => label.regionId === region.id)).toBe(true);
    const closeLabels = paintInk(canvas, {
      belonging: { pinned: region.id, regions: [region], territory },
      data,
      selected: "island",
      view: { height: 500, pixelsPerUnit: 5, width: 500, x: 0, y: 0 },
    });
    expect(closeLabels.some((label) => label.file?.id === "two")).toBe(false);
  });
  it("retires district and neighboring file labels as composition becomes dominant", () => {
    const { canvas } = canvasFixture();
    const view = { height: 500, pixelsPerUnit: 2, width: 500, x: 0, y: 0 };
    // A selected island shows no grouping until its responsibilities load.
    const unentered = paintInk(canvas, { data, selected: "island", view });
    expect(
      unentered
        .filter((label) => label.territory?.id === "island")
        .map((label) => label.text)
    ).toEqual(["Island"]);
    const district = {
      color: "#678",
      id: "district",
      label: "District",
      members: territory.files,
      polygons: memberContours(territory.files),
      uncertain: false,
    };
    const districts = paintInk(canvas, {
      belonging: { regions: [district], territory },
      data,
      selected: "island",
      view,
    });
    expect(districts.some((label) => label.regionId === "district")).toBe(true);
    expect(districts.some((label) => label.file)).toBe(false);
    const files = paintInk(canvas, {
      data,
      selected: "island",
      view: {
        ...view,
        pixelsPerUnit: 5,
      },
    });
    expect(files.filter((label) => label.file)).toHaveLength(2);
    const focused = paintInk(canvas, {
      data,
      fileId: "one",
      selected: "island",
      view: {
        ...view,
        pixelsPerUnit: 5,
      },
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
    const composition = paintInk(canvas, {
      data,
      fileId: "one",
      responsibility: overlay,
      selected: "island",
      view: { ...view, pixelsPerUnit: 8 },
    });
    expect(
      composition.filter((label) => label.file).map((label) => label.file?.id)
    ).toEqual(["one"]);
    expect(composition.find((label) => label.file?.id === "one")?.y).toBe(
      -21 / 8
    );
    const elsewhere = paintInk(canvas, {
      data,
      fileId: "one",
      responsibility: overlay,
      selected: "island",
      view: { ...view, pixelsPerUnit: 8, width: 40, x: 30 },
    });
    expect(
      elsewhere.filter((label) => label.file).map((label) => label.file?.id)
    ).toEqual(["two"]);
  });
  it("limits relationship labels to evidence and keeps a bounded amount of ink", () => {
    const { canvas } = canvasFixture();
    const [source] = territory.files;
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
    const crowded = paintInk(canvas, {
      data: { ...data, territories: [populated] },
      selected: "island",
      view,
    });
    expect(crowded.filter((label) => label.file).length).toBeLessThanOrEqual(
      15
    );
    const focused = paintInk(canvas, {
      data: { ...data, territories: [populated] },
      responsibility: {
        links: [],
        members: ["file:0"],
        pathDisagreement: [],
        related: [],
        territoryId: "island",
        totalLinks: 0,
        unresolved: [],
      },
      selected: "island",
      view,
    });
    expect(
      focused.filter((label) => label.file).map((label) => label.file?.id)
    ).toEqual(["file:0"]);
  });
  it("captions each package name with its real file count", () => {
    const { canvas } = canvasFixture();
    const labels = paintInk(canvas, {
      data,
      view: {
        height: 500,
        pixelsPerUnit: 1,
        width: 500,
        x: 0,
        y: 0,
      },
    });
    const caption = (text: string) =>
      labels.find((label) => label.text === text)?.caption;
    expect(caption("Island")).toBe("2 FILES");
    expect(caption("Other")).toBe("0 FILES");
  });
  it("prints lettered columns and numbered rows from the chart corner", () => {
    const { ctx } = canvasFixture();
    const view = { height: 500, pixelsPerUnit: 2, width: 500, x: 0, y: 0 };
    paintGridReferences(ctx as unknown as CanvasRenderingContext2D, view, data);
    const printed = ctx.fillText.mock.calls.map(([text]) => text);
    expect(printed).toContain("A");
    expect(printed).toContain("C");
    expect(printed).toContain("2");
    const column = ctx.fillText.mock.calls.find(([text]) => text === "C");
    expect(column?.[2]).toBeCloseTo(-250 + 9 / Math.cos(0.7));
    const row = ctx.fillText.mock.calls.find(([text]) => text === "2");
    expect(row?.[1]).toBe(-241);
    ctx.fillText.mockClear();
    paintGridReferences(
      ctx as unknown as CanvasRenderingContext2D,
      view,
      data,
      [
        {
          font: "20px SpyglassDisplay",
          height: 20,
          territory,
          text: "Island",
          width: 400,
          x: 0,
          y: -250 + 9 / Math.cos(0.7),
        },
      ]
    );
    // A place name covering the column margin hides its references.
    expect(ctx.fillText.mock.calls.map(([text]) => text)).not.toContain("C");
    ctx.fillText.mockClear();
    paintGridReferences(ctx as unknown as CanvasRenderingContext2D, view, data);
    paintGridReferences(
      ctx as unknown as CanvasRenderingContext2D,
      { ...view, x: 90 },
      data
    );
    // Panning never renames a cell.
    expect(
      ctx.fillText.mock.calls.filter(([text]) => text === "C").length
    ).toBe(2);
  });
});

describe("ink layers", () => {
  it("paints every layer once, in z-order, timing each in a developer session", () => {
    performance.clearMeasures();
    const { canvas } = canvasFixture();
    const view = { height: 500, pixelsPerUnit: 2, width: 500, x: 0, y: 0 };
    paintInk(canvas, { data, view });
    expect(
      performance
        .getEntriesByType("measure")
        .filter((entry) => entry.name.startsWith("spyglass:paint:ink:"))
    ).toEqual([]);
    paintInk(canvas, { data, developer: true, view });
    expect(
      performance
        .getEntriesByType("measure")
        .filter((entry) => entry.name.startsWith("spyglass:paint:ink:"))
        .map((entry) => entry.name.slice("spyglass:paint:ink:".length))
    ).toEqual(inkLayers.map((layer) => layer.id));
    performance.clearMeasures();
  });

  it("asks for the hovered island once labels are placed, and inks its coast last", () => {
    const { canvas, ctx } = canvasFixture();
    const view = { height: 500, pixelsPerUnit: 2, width: 500, x: 0, y: 0 };
    const seen: number[] = [];
    const labels = paintInk(canvas, {
      data,
      hovered: (placed) => {
        seen.push(placed.length);
        return data.territories[0] ?? null;
      },
      view,
    });
    expect(seen).toEqual([labels.length]);
    expect(labels.length).toBeGreaterThan(0);
    expect(ctx.stroke).toHaveBeenCalled();
  });
});

it("runs every layer that reads the placed labels after the labels layer", () => {
  const { canvas } = canvasFixture();
  const ctx = canvas.getContext("2d") as unknown as CanvasRenderingContext2D;
  const view = { height: 500, pixelsPerUnit: 2, width: 500, x: 0, y: 0 };
  const readers: string[] = [];
  for (const layer of inkLayers) {
    const state = inkState(ctx, ctx, {
      data,
      hovered: () => null,
      selected: "island",
      topography: [],
      view,
    });
    Object.defineProperty(state, "labels", {
      get: () => {
        readers.push(layer.id);
        return [];
      },
      set: () => undefined,
    });
    layer.paint(state);
  }
  const order: string[] = inkLayers.map((layer) => layer.id);
  const labels = order.indexOf("labels");
  expect(readers.length).toBeGreaterThan(0);
  for (const reader of new Set(readers)) {
    expect(order.indexOf(reader)).toBeGreaterThan(labels);
  }
});

it("draws with the ladder's inks: selection and labels", () => {
  const { canvas, ctx } = canvasFixture();
  const pen = ctx as unknown as CanvasRenderingContext2D;
  const used = new Set<string>();
  const record = () => {
    used.add(String(pen.strokeStyle));
    used.add(String(pen.fillStyle));
  };
  for (const method of ["fill", "fillRect", "fillText", "stroke"] as const) {
    ctx[method].mockImplementation(record);
  }
  const shore = {
    ...territory,
    coast: [
      [
        [
          [-90, -90],
          [90, -90],
          [90, 90],
          [-90, -90],
        ],
      ],
    ] as Territory["coast"],
  };
  paintInk(canvas, {
    data: { ...data, territories: [shore] },
    fileId: "one",
    selected: "island",
    view: { height: 500, pixelsPerUnit: 5, width: 500, x: 0, y: 0 },
  });
  for (const ink of [inks.selection, inks.label]) {
    expect(used).toContain(ink);
  }
  // The gilt and amber the ladder replaced are gone from these layers.
  expect(used).not.toContain("#b38a32");
  expect(used).not.toContain("#875222");
});

it("numbers the dependency layers on their rows and marks an unplaced island", () => {
  const { canvas, ctx } = canvasFixture();
  const labels = paintInk(canvas, {
    data: {
      ...data,
      packageLayers: { island: 0, "one-up": 1, other: null, "two-up": 2 },
      territories: [
        ...data.territories,
        { ...territory, id: "one-up", label: "One up", x: -300, y: -220 },
        { ...territory, id: "two-up", label: "Two up", x: 300, y: -440 },
      ],
    },
    view: { height: 1200, pixelsPerUnit: 1, width: 900, x: 0, y: -220 },
  });
  const printed = ctx.fillText.mock.calls.map(([text]) => text);
  expect(printed).toContain("FOUNDATION · 0");
  expect(printed).toContain("LAYER 1");
  expect(printed).toContain("LAYER 2");
  const tickAt = (text: string) =>
    ctx.fillText.mock.calls.find(([printedText]) => printedText === text)?.[2];
  expect(tickAt("LAYER 1")).toBe(latitude(1));
  expect(tickAt("LAYER 2")).toBe(latitude(2));
  expect(
    labels.find((label) => label.territory?.id === "other")?.caption
  ).toContain("NO LAYER");
  expect(
    labels.find((label) => label.territory?.id === "island")?.caption
  ).not.toContain("NO LAYER");
});

it("lets the latitude scale give way at island zoom, so it never prints over an island", () => {
  const printedAt = (pixelsPerUnit: number) => {
    const { canvas, ctx } = canvasFixture();
    paintInk(canvas, {
      data: { ...data, packageLayers: { island: 0 } },
      view: { height: 800, pixelsPerUnit, width: 600, x: 0, y: 0 },
    });
    return ctx.fillText.mock.calls.map(([text]) => String(text));
  };
  expect(printedAt(1)).toContain("FOUNDATION · 0");
  expect(printedAt(2.2)).not.toContain("FOUNDATION · 0");
});

it("draws no latitude scale without placed layers", () => {
  const { canvas, ctx } = canvasFixture();
  paintInk(canvas, {
    data: { ...data, packageLayers: {} },
    view: { height: 1200, pixelsPerUnit: 1, width: 900, x: 0, y: -220 },
  });
  const printed = ctx.fillText.mock.calls.map(([text]) => String(text));
  expect(printed.some((text) => text.startsWith("LAYER"))).toBe(false);
});

it("draws departures by default, and lets the selection's lines win while anything is selected", () => {
  const departing = withReadings(data, {
    placement: {
      dominantShare: 0.6,
      labelled: ["island"],
      places: {
        "file:src/one.ts": {
          away: [{ modules: 2, package: "other" }],
          home: 0,
          label: "departs" as const,
          level: "file" as const,
          package: "island",
          place: "src/one.ts",
          share: 1,
          toward: "other",
          unindexed: 0,
        },
      },
    },
  });
  const strokes = (chosen: string | null) => {
    const { canvas, ctx } = canvasFixture();
    const pen = ctx as unknown as CanvasRenderingContext2D;
    const curves: string[] = [];
    const rings: string[] = [];
    ctx.quadraticCurveTo.mockImplementation(() =>
      curves.push(String(pen.strokeStyle))
    );
    ctx.arc.mockImplementation(() => rings.push(String(pen.strokeStyle)));
    paintInk(canvas, {
      data: departing,
      selected: chosen,
      view: { height: 500, pixelsPerUnit: 1, width: 500, x: 0, y: 0 },
    });
    return { curves, rings };
  };
  const shown = strokes(null);
  expect(shown.rings).toContain(inks.departure);
  expect(shown.curves).toContain(inks.departureLine);
  const selected = strokes("island");
  // The ring stays on land; the line gives way to the selection's.
  expect(selected.rings).toContain(inks.departure);
  expect(selected.curves).not.toContain(inks.departureLine);
  expect(selected.curves).toContain(inks.selection);
});

it("sets the latitude scale on a paper plate on a narrow screen, where islands reach the margin", () => {
  const plates = (width: number) => {
    const { canvas, ctx } = canvasFixture();
    const pen = ctx as unknown as CanvasRenderingContext2D;
    const filled: string[] = [];
    ctx.fillRect.mockImplementation(() => filled.push(String(pen.fillStyle)));
    paintInk(canvas, {
      data: { ...data, packageLayers: { island: 0 } },
      view: { height: 800, pixelsPerUnit: 1, width, x: 0, y: 0 },
    });
    return filled.filter((fill) => fill === inks.labelHalo).length;
  };
  // One plate under each number: the foundation's here.
  expect(plates(390)).toBe(1);
  expect(plates(1500)).toBe(0);
});

it("rings a departing place once, notched at the top", () => {
  const close = withReadings(data, {
    placement: {
      dominantShare: 0.6,
      labelled: ["island"],
      places: {
        "file:src/one.ts": {
          away: [{ modules: 2, package: "other" }],
          home: 0,
          label: "departs" as const,
          level: "file" as const,
          package: "island",
          place: "src/one.ts",
          share: 1,
          toward: "other",
          unindexed: 0,
        },
      },
    },
    proximity: {
      apart: { coChanges: [], files: [] },
      close: [
        {
          folder: "src",
          groups: [
            { apart: [], files: ["src/one.ts"], responsibilities: ["a"] },
            { apart: [], files: ["src/two.ts"], responsibilities: ["b"] },
          ],
          package: "island",
          unresolved: 0,
        },
      ],
      labelled: ["island"],
    },
  });
  const { canvas, ctx } = canvasFixture();
  const pen = ctx as unknown as CanvasRenderingContext2D;
  const arcs: { args: number[]; ink: string }[] = [];
  ctx.arc.mockImplementation((...args: number[]) =>
    arcs.push({ args, ink: String(pen.strokeStyle) })
  );
  paintInk(canvas, {
    data: close,
    view: { height: 500, pixelsPerUnit: 2.2, width: 500, x: 0, y: 0 },
  });
  // One arc round one centre, notched at the top; the "( )" of a close
  // folder is a mark of its own (`layout/proximity-marks.ts`).
  const ring = arcs.filter((arc) => arc.ink === inks.departure);
  expect(ring).toHaveLength(1);
  const [, , , from = 0, to = 0] = ring[0]?.args ?? [];
  expect(to - from).toBeGreaterThan(Math.PI);
});

it("names folders at island zoom in italics ending in a slash, and none on an island rearranged by responsibility", () => {
  const files = [
    "pkg/src/web/a.ts",
    "pkg/src/web/b.ts",
    "pkg/src/lib/c.ts",
    "pkg/src/lib/d.ts",
  ].map((path, i) => ({
    ...territory.files[0],
    directory: path.slice(0, path.lastIndexOf("/")),
    id: path,
    path,
    x: i,
    y: 0,
  })) as Territory["files"];
  const tree = settleFiles(files, 80, "pkg");
  const island = { ...territory, files, folder: "pkg" };
  const foldered = {
    ...data,
    folderCells: { island: tree },
    territories: [island],
  };
  const paint = (belonging?: Parameters<typeof paintInk>[1]["belonging"]) => {
    const { canvas, ctx } = canvasFixture();
    const pen = ctx as unknown as CanvasRenderingContext2D;
    const names: { font: string; ink: string; text: string }[] = [];
    ctx.fillText.mockImplementation((text: string) =>
      names.push({ font: pen.font, ink: String(pen.fillStyle), text })
    );
    paintInk(canvas, {
      belonging,
      data: foldered,
      view: { height: 500, pixelsPerUnit: 2.2, width: 500, x: 0, y: 0 },
    });
    return { names };
  };
  const shown = paint();
  expect(shown.names).toContainEqual({
    font: expect.stringContaining("italic"),
    ink: inks.folder,
    text: "lib/",
  });
  const rearranged = paint({
    regions: [],
    territory: { ...island, files: files.map((f) => ({ ...f })) },
  });
  expect(rearranged.names.map((name) => name.text)).not.toContain("lib/");
});

it("leaves a district's name to the folder when the district is named as the folder it sits in, and sets folder names above their bead", () => {
  const files = [
    "pkg/src/web/a.ts",
    "pkg/src/web/b.ts",
    "pkg/src/lib/c.ts",
    "pkg/src/lib/d.ts",
  ].map((path, i) => ({
    ...territory.files[0],
    directory: path.slice(0, path.lastIndexOf("/")),
    id: path,
    path,
    x: i,
    y: 0,
  })) as Territory["files"];
  const tree = settleFiles(files, 80, "pkg");
  const island = { ...territory, files, folder: "pkg" };
  const region = (id: string, label: string, members: typeof files) => ({
    color: "#000000",
    id,
    label,
    members,
    polygons: [],
    uncertain: false,
  });
  const lib = files.filter((f) => f.directory.endsWith("lib"));
  const web = files.filter((f) => f.directory.endsWith("web"));
  const { canvas, ctx } = canvasFixture();
  const printed: { text: string; y: number }[] = [];
  ctx.fillText.mockImplementation((text: string, _x: number, y: number) =>
    printed.push({ text, y })
  );
  paintInk(canvas, {
    belonging: {
      regions: [region("r1", "src/lib", lib), region("r2", "Sessions", web)],
      territory: island,
    },
    data: { ...data, folderCells: { island: tree }, territories: [island] },
    view: { height: 500, pixelsPerUnit: 2.2, width: 500, x: 0, y: 0 },
  });
  const texts = printed.map((label) => label.text);
  expect(texts).toContain("lib/");
  expect(texts).not.toContain("lib");
  // A district named otherwise keeps its name beside the folder's.
  expect(texts).toContain("Sessions");
  const libCell = tree.folders[0]?.folders.find(
    (cell) => cell.folder === "src/lib"
  );
  const centroid =
    (libCell?.sites ?? []).reduce((sum, site) => sum + site.y, 0) /
    Math.max(1, libCell?.sites.length ?? 1);
  expect(printed.find((label) => label.text === "lib/")?.y).toBeCloseTo(
    centroid - 13 / 2.2
  );
});

it("letters a chosen domain's name once and plugs the departures it explains; nothing unchosen", () => {
  const files = [
    "pkg/src/web/a.ts",
    "pkg/src/web/b.ts",
    "pkg/src/lib/c.ts",
    "pkg/src/lib/d.ts",
  ].map((path, i) => ({
    ...territory.files[0],
    directory: path.slice(0, path.lastIndexOf("/")),
    id: path,
    path,
    x: i,
    y: 0,
  })) as Territory["files"];
  const island = { ...territory, files, folder: "pkg" };
  const other = { ...territory, files: [], folder: "other", id: "other" };
  const chosen = withReadings(
    {
      ...data,
      folderCells: { island: settleFiles(files, 80, "pkg") },
      territories: [island, other],
    },
    {
      domains: {
        declared: [
          {
            name: "shapes",
            parents: [],
            places: [
              { kind: "folder" as const, place: "pkg/src/lib" },
              { kind: "file" as const, place: "pkg/src/web/a.ts" },
            ],
            unmatched: [],
          },
        ],
        placements: {
          "file:pkg/src/web/a.ts": {
            away: { shared: 2, total: 2, unindexed: 0 },
            domainLabel: "shares-domain" as const,
            domains: ["shapes"],
            level: "file" as const,
            package: "island",
            place: "pkg/src/web/a.ts",
            placementLabel: "departs" as const,
            sharedDomains: ["shapes"],
          },
        },
      },
      placement: {
        dominantShare: 0.6,
        labelled: ["island"],
        places: {
          "file:pkg/src/web/a.ts": {
            away: [{ modules: 2, package: "other" }],
            home: 0,
            label: "departs" as const,
            level: "file" as const,
            package: "island",
            place: "pkg/src/web/a.ts",
            share: 1,
            toward: "other",
            unindexed: 0,
          },
        },
      },
    }
  );
  const paint = (
    name: string | null,
    belonging?: Parameters<typeof paintInk>[1]["belonging"]
  ) => {
    const { canvas, ctx } = canvasFixture();
    const pen = ctx as unknown as CanvasRenderingContext2D;
    const arcs: string[] = [];
    const names: { ink: string; text: string }[] = [];
    ctx.arc.mockImplementation(() => arcs.push(String(pen.strokeStyle)));
    ctx.fillText.mockImplementation((text: string) =>
      names.push({ ink: String(pen.fillStyle), text })
    );
    paintInk(canvas, {
      belonging,
      data: chosen,
      domain: name ? { frame: "", name } : null,
      view: { height: 500, pixelsPerUnit: 2.2, width: 500, x: 0, y: 0 },
    });
    return { arcs, names };
  };
  const shown = paint("shapes");
  const unchosen = paint(null);
  expect(shown.arcs).toContain(inks.domain);
  expect(shown.names.filter((name) => name.text === "domain shapes")).toEqual([
    { ink: inks.domainName, text: "domain shapes" },
  ]);
  expect(unchosen.arcs).not.toContain(inks.domain);
  expect(unchosen.names.map((name) => name.text)).not.toContain(
    "domain shapes"
  );
});
