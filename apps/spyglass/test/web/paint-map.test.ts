import { describe, expect, it, vi } from "vitest";
import type { Territory } from "../../src/web/data/types";
import { inks } from "../../src/web/ladder/ink-ladder";
import { settleFiles } from "../../src/web/layout/folder-sectors";
import type { MapLabel } from "../../src/web/layout/labels";
import { inkLayers } from "../../src/web/scene/ink/layers";
import { inkState } from "../../src/web/scene/ink/state";
import { paintInk } from "../../src/web/scene/paint-map";
import { withReadings } from "../helpers/frames";
import {
  twoIslands as data,
  island as territory,
} from "../helpers/island-fixture";

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

/** Labels as the labels layer would place them: the island's name on the sea. */
const placedLabels: readonly MapLabel[] = [
  {
    caption: "2 FILES",
    font: { face: "SpyglassDisplay" },
    halo: 6,
    height: 13,
    ink: inks.label,
    kind: "island",
    territory,
    text: "Island",
    width: 40,
    x: 0,
    y: -97,
    z: 0.42,
  },
];

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

  it("asks for the hovered island with the labels it was given, and inks its coast last", () => {
    const { canvas, ctx } = canvasFixture();
    const view = { height: 500, pixelsPerUnit: 2, width: 500, x: 0, y: 0 };
    const seen: (readonly MapLabel[])[] = [];
    paintInk(canvas, {
      data,
      hovered: (placed) => {
        seen.push(placed);
        return data.territories[0] ?? null;
      },
      labels: placedLabels,
      view,
    });
    expect(seen).toEqual([placedLabels]);
    expect(ctx.stroke).toHaveBeenCalled();
  });
});

it("reads the labels the labels layer placed, since no painted layer places any", () => {
  const { canvas } = canvasFixture();
  const ctx = canvas.getContext("2d") as unknown as CanvasRenderingContext2D;
  const view = { height: 500, pixelsPerUnit: 2, width: 500, x: 0, y: 0 };
  const state = inkState(ctx, {
    data,
    hovered: () => null,
    labels: placedLabels,
    selected: "island",
    topography: [],
    view,
  });
  expect(state.labels).toBe(placedLabels);
  expect(inkState(ctx, { data, view }).labels).toEqual([]);
  // The layers that clear around labels read them, and none writes them.
  const readers: string[] = [];
  for (const layer of inkLayers) {
    const watched = inkState(ctx, {
      data,
      hovered: () => null,
      selected: "island",
      view,
    });
    Object.defineProperty(watched, "labels", {
      get: () => {
        readers.push(layer.id);
        return placedLabels;
      },
      set: () => {
        throw new Error(`${layer.id} placed labels`);
      },
    });
    layer.paint(watched);
  }
  expect(new Set(readers)).toEqual(
    new Set(["topography", "crossings", "departures", "selection", "hover"])
  );
  expect(inkLayers.map((layer) => String(layer.id))).not.toContain("labels");
});

it("draws with the ladder's inks: the selection", () => {
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
    selected: "island",
    view: { height: 500, pixelsPerUnit: 1, width: 500, x: 0, y: 0 },
  });
  expect(used).toContain(inks.selection);
  // No layer letters: every string is the labels layer's.
  expect(ctx.fillText).not.toHaveBeenCalled();
  expect(ctx.strokeText).not.toHaveBeenCalled();
  // The gilt and amber the ladder replaced are gone from these layers.
  expect(used).not.toContain("#b38a32");
  expect(used).not.toContain("#875222");
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

it("plugs the departures a chosen domain explains; nothing unchosen", () => {
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
  const paint = (name: string | null) => {
    const { canvas, ctx } = canvasFixture();
    const pen = ctx as unknown as CanvasRenderingContext2D;
    const arcs: string[] = [];
    ctx.arc.mockImplementation(() => arcs.push(String(pen.strokeStyle)));
    paintInk(canvas, {
      data: chosen,
      domain: name ? { frame: "", name } : null,
      view: { height: 500, pixelsPerUnit: 2.2, width: 500, x: 0, y: 0 },
    });
    return { arcs };
  };
  expect(paint("shapes").arcs).toContain(inks.domain);
  expect(paint(null).arcs).not.toContain(inks.domain);
});
