// @vitest-environment happy-dom
import { Vector3 } from "three";
import { afterEach, expect, it, vi } from "vitest";
import { paperThickness } from "../../src/web/data/bindings";
import { createChartCamera } from "../../src/web/scene/chart-camera";
import { chartTilt } from "../../src/web/view/chart-view";
import { loadSpyglass } from "../helpers/reference-spyglass";

/** The pixels one map unit spans on screen at the camera's zoom. */
const pixelsPerUnit = (
  camera: { left: number; right: number; zoom: number },
  width: number
) => (width * camera.zoom) / (camera.right - camera.left);

/** A host whose size the test sets, since happy-dom lays nothing out. */
function sized(width: number, height: number) {
  const host = document.createElement("div");
  Object.defineProperty(host, "clientWidth", {
    configurable: true,
    get: () => width,
  });
  Object.defineProperty(host, "clientHeight", {
    configurable: true,
    get: () => height,
  });
  return host;
}

let dispose: (() => void) | undefined;
afterEach(() => {
  dispose?.();
  dispose = undefined;
  document.body.innerHTML = "";
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

async function build(reducedMotion = true) {
  const data = await loadSpyglass();
  const host = sized(800, 600);
  const canvas = document.createElement("canvas");
  host.append(canvas);
  document.body.append(host);
  const chart = createChartCamera({
    canvas,
    data,
    host,
    onChange: vi.fn(),
    // A flight lands at once.
    reducedMotion: { matches: reducedMotion } as MediaQueryList,
    sea: {
      height: Math.max(data.height, data.width) * 6.6,
      panRoom: 2.2,
      width: Math.max(data.height, data.width) * 6.6,
    },
  });
  ({ dispose } = chart);
  const resizeTo = (width: number, height: number) => {
    Object.defineProperty(host, "clientWidth", {
      configurable: true,
      get: () => width,
    });
    Object.defineProperty(host, "clientHeight", {
      configurable: true,
      get: () => height,
    });
    chart.resize();
  };
  chart.resize();
  const territory = data.territories.find((item) => item.files.length > 0);
  const file = territory?.files[0];
  if (!(territory && file)) {
    throw new Error("The fixture has no island with files.");
  }
  return { canvas, chart, data, file, resizeTo, territory };
}

it("keeps a focused file readable across a resize, and an island framed", async () => {
  const { chart, file, resizeTo, territory } = await build();
  const target = new Vector3(territory.x + file.x, -territory.y - file.y, 0);
  chart.focus({ file, target, territory });
  expect(pixelsPerUnit(chart.camera, 800)).toBeCloseTo(10);
  // The viewport narrows: the file spans the same pixels, so the zoom moved.
  const fileZoom = chart.camera.zoom;
  resizeTo(400, 600);
  expect(pixelsPerUnit(chart.camera, 400)).toBeCloseTo(10);
  expect(chart.camera.zoom).not.toBeCloseTo(fileZoom);
  // An island focus is framed instead: the zoom holds, the pixels do not.
  chart.focus({ file: undefined, target, territory });
  const islandZoom = chart.camera.zoom;
  expect(pixelsPerUnit(chart.camera, 400)).toBeCloseTo(2.2);
  resizeTo(800, 600);
  expect(chart.camera.zoom).toBeCloseTo(islandZoom);
  expect(pixelsPerUnit(chart.camera, 800)).not.toBeCloseTo(2.2);
});

it("returns to the overview for a focus on nothing, and no longer keeps a file's pixels", async () => {
  const { chart, file, resizeTo, territory } = await build();
  const target = new Vector3(territory.x + file.x, -territory.y - file.y, 0);
  chart.focus({ file, target, territory });
  const fileZoom = chart.camera.zoom;
  chart.focus({ file: undefined, target: new Vector3(), territory: null });
  expect(chart.camera.zoom).toBeLessThan(fileZoom);
  expect(chart.camera.zoom).toBeLessThan(2);
  // The overview is fitted to the viewport, not held at any pixels per unit.
  resizeTo(400, 600);
  expect(pixelsPerUnit(chart.camera, 400)).not.toBeCloseTo(10);
  expect(chart.camera.zoom).toBeLessThan(fileZoom);
});

it("keeps the original fixed chart angle through projection, zoom, focus, and restoration", async () => {
  const { chart, canvas, territory } = await build();
  const initial = chart.captureView();
  expect(initial).not.toHaveProperty("presentation");
  expect(chart).not.toHaveProperty("setPresentation");
  Object.defineProperty(canvas, "getBoundingClientRect", {
    value: () => ({ height: 600, left: 0, top: 0, width: 800 }),
  });
  chart.zoom(2);
  chart.focus({ file: undefined, target: new Vector3(20, -30, 0), territory });
  chart.camera.updateMatrixWorld();
  const view = chart.view();
  expect(view.tilt).toBe(chartTilt);
  expect(view).not.toHaveProperty("presentation");
  expect(view.height * view.pixelsPerUnit * Math.cos(chartTilt)).toBeCloseTo(
    600
  );
  const world = new Vector3(40, -30, paperThickness);
  const projected = world.clone().project(chart.camera);
  const point = chart.chartPoint({
    clientX: ((projected.x + 1) / 2) * 800,
    clientY: ((1 - projected.y) / 2) * 600,
  });
  expect(point?.x).toBeCloseTo(world.x);
  expect(point?.y).toBeCloseTo(world.y);
  expect(point?.z).toBeCloseTo(world.z);
  chart.restoreView(initial);
  expect(chart.captureView()).toEqual(initial);
  const forward = chart.camera.getWorldDirection(new Vector3());
  expect(forward.y).toBeCloseTo(Math.sin(chartTilt));
  expect(forward.z).toBeCloseTo(-Math.cos(chartTilt));
});

/** Drive only the camera's scheduled frames; no wall-clock waits. */
function animationClock() {
  let now = 0;
  let next = 0;
  const frames = new Map<number, FrameRequestCallback>();
  vi.spyOn(performance, "now").mockImplementation(() => now);
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    next += 1;
    frames.set(next, callback);
    return next;
  });
  vi.stubGlobal("cancelAnimationFrame", (id: number) => frames.delete(id));
  return {
    pending: () => frames.size,
    step(milliseconds: number) {
      now += milliseconds;
      const callbacks = [...frames.values()];
      frames.clear();
      for (const callback of callbacks) {
        callback(now);
      }
    },
  };
}

it("cancels camera flights on restoration and disposal while preserving the fixed angle", async () => {
  const clock = animationClock();
  const { chart } = await build(false);
  const saved = chart.captureView();
  chart.flyToPoint({ x: 100, y: 100 });
  clock.step(325);
  expect(chart.captureView().x).toBeGreaterThan(0);
  chart.restoreView(saved);
  expect(clock.pending()).toBe(0);
  clock.step(650);
  expect(chart.captureView()).toEqual(saved);
  chart.flyToPoint({ x: 100, y: 100 });
  expect(clock.pending()).toBe(1);
  chart.dispose();
  dispose = undefined;
  expect(clock.pending()).toBe(0);
  clock.step(650);
  expect(chart.view().tilt).toBe(chartTilt);
});

it("tracks a moving boat through the entry flight and follows directly after landing", async () => {
  const clock = animationClock();
  const { chart } = await build(false);
  const saved = chart.captureView();
  chart.flyToPoint({ x: 20, y: 30 });
  clock.step(325);
  chart.followPoint({ x: 50, y: 60 });
  clock.step(325);
  expect(chart.captureView()).toMatchObject({
    x: expect.closeTo(50),
    y: expect.closeTo(-60),
  });
  expect(chart.captureView().pixels).toBeCloseTo(4.5);
  chart.followPoint({ x: 51, y: 62 });
  expect(chart.captureView()).toMatchObject({
    x: expect.closeTo(51),
    y: expect.closeTo(-62),
  });
  expect(clock.pending()).toBe(0);
  chart.restoreView(saved);
  expect(chart.captureView()).toEqual(saved);
});

it.each([
  [1100, 760],
  [390, 844],
])(
  "frames the whole geography with chrome clearance at %sx%s at the fixed chart angle",
  async (width, height) => {
    const { chart, data, resizeTo } = await build();
    resizeTo(width, height);
    chart.focus({ file: undefined, target: new Vector3(), territory: null });
    chart.camera.updateMatrixWorld();
    const points = [-1, 1].flatMap((x) =>
      [-1, 1].map((y) => {
        const projected = new Vector3(
          (x * data.width) / 2,
          (y * data.height) / 2,
          0
        ).project(chart.camera);
        return {
          x: ((projected.x + 1) * width) / 2,
          y: ((1 - projected.y) * height) / 2,
        };
      })
    );
    for (const point of points) {
      expect(point.x).toBeGreaterThanOrEqual(Math.min(48, width * 0.08) - 1);
      expect(point.x).toBeLessThanOrEqual(
        width - Math.min(48, width * 0.08) + 1
      );
      expect(point.y).toBeGreaterThanOrEqual(Math.min(112, height * 0.2) - 1);
      expect(point.y).toBeLessThanOrEqual(
        height - Math.min(112, height * 0.2) + 1
      );
    }
    expect(chart.view().tilt).toBe(chartTilt);
  }
);
