import { MeshBasicMaterial, Texture } from "three";
import { afterEach, expect, it, vi } from "vitest";
import type { BelongingLayer } from "../../src/web/belonging";
import {
  type PreparedRelief,
  prepareRelief,
  type ReliefRequest,
} from "../../src/web/scene/prepare-relief";
import { createReliefLayer } from "../../src/web/scene/relief-layer";
import type { Territory } from "../../src/web/types";

const territory: Territory = {
  analyzed: true,
  coast: [
    [
      [
        [-20, -20],
        [20, -20],
        [20, 20],
        [-20, 20],
        [-20, -20],
      ],
    ],
  ],
  color: "#fff",
  files: [
    {
      directory: "src",
      id: "shared",
      incoming: 0,
      kind: "source",
      outgoing: 0,
      path: "src/shared.ts",
      x: 0,
      y: 0,
    },
  ],
  hills: [],
  id: "island",
  label: "Island",
  neighborhoods: [],
  radius: 20,
  shallows: [],
  x: 0,
  y: 0,
};
const [file] = territory.files;
if (!file) {
  throw new Error("Missing fixture file");
}
const belonging: BelongingLayer = {
  features: {
    confluences: [],
    landmarks: [
      {
        consumers: [],
        file,
        footprint: [],
        kind: "summit",
        radius: 5,
        role: "commons",
      },
    ],
    marshes: [],
    omitted: [],
    rivers: [],
    streams: [],
    unrouted: 0,
  },
  regions: [],
  territory,
};
const workers: TestWorker[] = [];
class TestWorker {
  onmessage: ((event: MessageEvent<PreparedRelief>) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;
  request?: ReliefRequest;
  postMessage(request: ReliefRequest) {
    this.request = request;
  }
  terminate = vi.fn();
  constructor() {
    workers.push(this);
  }
  complete() {
    if (!this.request) {
      throw new Error("Missing worker request");
    }
    this.onmessage?.(
      new MessageEvent("message", { data: prepareRelief(this.request) })
    );
  }
}
afterEach(() => {
  workers.length = 0;
  vi.unstubAllGlobals();
});

function layer() {
  return createReliefLayer(
    {
      coverage: "complete",
      fileEdges: [],
      generatedAt: "now",
      height: 100,
      routes: [],
      territories: [territory],
      width: 100,
    },
    new MeshBasicMaterial(),
    new Texture(),
    0.7
  );
}

it("keeps the visible terrain while preparing, cancels stale evidence and reuses completed relief across zoom exits", async () => {
  vi.stubGlobal("Worker", TestWorker);
  const relief = layer();
  try {
    const base = relief.fieldFor(territory);
    const pending = relief.setFeatures(belonging);
    expect(relief.fieldFor(territory)).toBe(base);
    const [stale] = workers;
    const late = stale?.onmessage;
    await relief.setFeatures(null);
    expect(await pending).toBe(false);
    expect(stale?.terminate).toHaveBeenCalled();
    expect(stale?.onmessage).toBeNull();
    if (stale?.request) {
      late?.(
        new MessageEvent("message", { data: prepareRelief(stale.request) })
      );
    }
    expect(relief.fieldFor(territory)).toBe(base);
    const current = relief.setFeatures(belonging);
    workers[1]?.complete();
    expect(await current).toBe(true);
    const detailed = relief.fieldFor(territory);
    expect(detailed.sample(0, 0).elevation).toBeGreaterThan(
      base.sample(0, 0).elevation
    );
    const contours = relief.contours();
    await relief.setFeatures(null);
    expect(relief.fieldFor(territory)).toBe(base);
    await relief.setFeatures(structuredClone(belonging));
    expect(relief.fieldFor(territory)).toBe(detailed);
    expect(relief.contours()).toEqual(contours);
    expect(workers).toHaveLength(2);
  } finally {
    relief.dispose();
  }
});

it("cancels pending terrain when the scene is disposed", async () => {
  vi.stubGlobal("Worker", TestWorker);
  const relief = layer();
  const pending = relief.setFeatures(belonging);
  relief.dispose();
  expect(await pending).toBe(false);
  expect(workers[0]?.terminate).toHaveBeenCalled();
});

it("prepares equivalent relief without workers and preserves the base vertices", async () => {
  vi.stubGlobal("Worker", undefined);
  const relief = layer();
  const base = relief.fieldFor(territory);
  try {
    expect(await relief.setFeatures(belonging)).toBe(true);
    await relief.setFeatures(null);
    expect(relief.fieldFor(territory)).toBe(base);
  } finally {
    relief.dispose();
  }
});
