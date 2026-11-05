import { describe, expect, it } from "vitest";
import type { PreparedVisualization } from "../../src/lib/visualization/types";
import { readIslandsChartInputs } from "../../src/web/islands-host/chart";
import {
  DEFAULT_ISLANDS_SETTINGS,
  type IslandsStats,
  type IslandsView,
} from "../../src/web/islands-host/islands-api";
import {
  compositionOf,
  inkViewOf,
  islandsSettingsOf,
  pitchOf,
  projectionOf,
  renderStatusOf,
  selectedIdOf,
  selectionOf,
  tiltOf,
  zoomed,
} from "../../src/web/islands-host/map-view";
import { island } from "../helpers/island-fixture";

const size = { height: 400, width: 600 };

const overview: IslandsView = {
  distance: 1000,
  pitch: Math.PI / 3,
  target: [40, 0, -20],
  yaw: 0,
};

describe("the view the labels read from an Islands camera", () => {
  it("centres on the target, scales by Islands' pixels per unit and tilts off the pitch", () => {
    const view = inkViewOf({ pixelsPerUnit: () => 2, view: overview }, size);
    expect(view.x).toBe(40);
    expect(view.y).toBe(-20);
    expect(view.pixelsPerUnit).toBe(2);
    expect(view.tilt).toBeCloseTo(Math.PI / 6);
    expect(view.width).toBeCloseTo(300);
    expect(view.height).toBeCloseTo(200 / Math.cos(Math.PI / 6));
  });

  it("keeps the extent finite when Islands gives no scale", () => {
    const view = inkViewOf({ pixelsPerUnit: () => 0, view: overview }, size);
    expect(Number.isFinite(view.width)).toBe(true);
    expect(Number.isFinite(view.height)).toBe(true);
  });

  it("reads the reader's elevation as the orbit's pitch", () => {
    expect(pitchOf(90)).toBeCloseTo(Math.PI / 2);
    expect(tiltOf({ pitch: pitchOf(90) })).toBeCloseTo(0);
  });
});

describe("where labels fall on the canvas", () => {
  const heights: number[] = [];
  const islands = {
    heightAt: ([x]: readonly [number, number]) => (x > 0 ? 3 : -2),
    project: ([x, y]: readonly [number, number], height = 0) => {
      heights.push(height);
      return { visible: y >= 0, x: x * 10, y: y * 10 };
    },
  };
  const project = projectionOf(islands, () => size);

  it("raises a point onto the land, and holds one on the water at sea level", () => {
    heights.length = 0;
    expect(project(1, 2)).toEqual({ x: 10, y: 20 });
    expect(project(-1, 2)).toEqual({ x: -10, y: 20 });
    expect(heights).toEqual([3, 0]);
  });

  it("sends a point Islands cannot see off the canvas", () => {
    const point = project(1, -1);
    expect(point.x).toBeLessThan(-size.width);
    expect(point.y).toBeLessThan(-size.height);
  });
});

describe("camera commands", () => {
  it("zooms by moving the orbit closer", () => {
    expect(zoomed(overview, 2).distance).toBe(500);
    expect(zoomed(overview, 1 / 1.35).distance).toBeCloseTo(1350);
  });
});

describe("selection between Islands and the viewer", () => {
  const data = { territories: [island] };

  it("names an island by its territory, and a ring as nothing", () => {
    expect(
      selectionOf(
        { id: "island", islands: ["Island"], kind: "island", name: "Island" },
        data
      )
    ).toEqual({ territory: island });
    expect(
      selectionOf(
        { id: "group:1", islands: ["Island"], kind: "ring", name: "zod" },
        data
      )
    ).toBeNull();
    expect(selectionOf(null, data)).toBeNull();
  });

  it("names a module by its file, on the territory that holds it", () => {
    const [file] = island.files;
    expect(
      selectionOf(
        {
          id: file?.id ?? "",
          islands: ["Island"],
          kind: "module",
          name: "file",
        },
        data
      )
    ).toEqual({ file, territory: island });
    expect(
      selectionOf(
        { id: "nowhere.ts", islands: [], kind: "module", name: "nowhere.ts" },
        data
      )
    ).toBeNull();
  });

  it("chooses a file as its module, else the island", () => {
    expect(selectedIdOf({ fileId: "one", territoryId: "island" })).toBe("one");
    expect(selectedIdOf({ territoryId: "island" })).toBe("island");
    expect(selectedIdOf(null)).toBeNull();
  });
});

describe("settings and readouts", () => {
  it("stills the waves for reduced motion and for rim surf off", () => {
    expect(islandsSettingsOf({ waves: true }, false).waveAmplitude).toBe(
      DEFAULT_ISLANDS_SETTINGS.waveAmplitude
    );
    expect(islandsSettingsOf({ waves: true }, true).waveAmplitude).toBe(0);
    expect(islandsSettingsOf({ waves: false }, false).waveAmplitude).toBe(0);
  });

  const stats: IslandsStats = {
    buildMs: 12,
    depths: null,
    frameMs: 2,
    hovered: null,
    islands: 3,
    levels: 1,
    mapMs: { coverage: 1.5, height: 2 },
    rebuilt: ["coverage", "height"],
    segments: 40,
    selected: null,
    terrainMs: 3,
    texels: 1024,
    waterMs: 1,
  };

  it("reads the frame's GPU time as the two passes'", () => {
    expect(renderStatusOf(stats, null)).toMatchObject({
      backend: "webgpu",
      failure: null,
      frameMs: 4,
    });
    expect(renderStatusOf(null, "lost").frameMs).toBeNull();
  });

  it("lists the labels, the maps and the passes as the composition", () => {
    const nodes = compositionOf(stats, { counts: { placed: 4 }, updateMs: 2 });
    expect(nodes.map(({ id, kind }) => `${kind}:${id}`)).toEqual([
      "labels:labels",
      "layer:map:coverage",
      "layer:map:height",
      "stage:terrain",
      "stage:water",
    ]);
    expect(nodes.at(-2)?.counts).toEqual({ gpuMs: 3 });
  });
});

describe("the chart's inputs", () => {
  const map = { schemaVersion: 1 } as unknown as PreparedVisualization;
  const reader = (lenses: Record<string, unknown>) => ({
    dependencyGraph: () => Promise.resolve({ edges: [], nodes: [] }),
    lens: (id: string) =>
      id in lenses
        ? Promise.resolve(lenses[id])
        : Promise.reject(new Error(`The dataset has no ${id} lens.`)),
    moduleEdgeShards: () => Promise.resolve([{ edges: [], package: "a" }]),
    moduleIndex: () => Promise.resolve({ modules: [] }),
    moduleShards: () => Promise.resolve([{ modules: [], package: "a" }]),
  });

  it("reads the map, the graph and the islands' insides in the adapter's shapes", async () => {
    const inputs = await readIslandsChartInputs(
      reader({
        "frequent-change": { packages: [] },
        "responsibility-groups": { packages: [] },
      }) as never,
      map
    );
    expect(inputs.map).toBe(map);
    expect(inputs.graph).toEqual({ edges: [], nodes: [] });
    expect(inputs.internals).toEqual({
      edges: [{ edges: [], package: "a" }],
      frequentChange: { packages: [] },
      modules: { modules: [] },
      responsibilityGroups: { packages: [] },
      shards: [{ modules: [], package: "a" }],
    });
    expect(inputs.notes).toEqual([]);
  });

  it("does without a lens the dataset lacks, and says so", async () => {
    const inputs = await readIslandsChartInputs(reader({}) as never, map);
    expect(inputs.internals.frequentChange).toBeUndefined();
    expect(inputs.notes).toHaveLength(2);
  });
});
