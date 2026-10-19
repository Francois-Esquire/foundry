// @vitest-environment happy-dom
import { Vector3 } from "three";
import { afterEach, expect, it, vi } from "vitest";
import { paperThickness } from "../../src/web/data/bindings";
import { createChartCamera } from "../../src/web/scene/chart-camera";
import { dioramaTilt } from "../../src/web/view/chart-view";
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
    sea: { height: data.height * 3, panRoom: 2.2, width: data.width * 3 },
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
  return { canvas, chart, file, resizeTo, territory };
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

it("turns the same camera from a true atlas to 55 degrees while preserving the target and horizontal scale", async () => {
  const { chart, canvas } = await build();
  chart.zoom(2);
  const initial = chart.captureView();
  const { camera } = chart;
  expect(chart.view().tilt).toBe(0);
  Object.defineProperty(canvas, "getBoundingClientRect", {
    value: () => ({ height: 600, left: 0, top: 0, width: 800 }),
  });
  for (const presentation of [0, 0.3, 0.6, 1]) {
    chart.setPresentation(presentation);
    const view = chart.view();
    expect(chart.camera).toBe(camera);
    expect(view.presentation).toBe(presentation);
    expect(view.tilt).toBeCloseTo(presentation * dioramaTilt);
    expect(chart.captureView().x).toBeCloseTo(initial.x);
    expect(chart.captureView().y).toBeCloseTo(initial.y);
    expect(chart.captureView().pixels).toBeCloseTo(initial.pixels);
    expect(
      view.height * view.pixelsPerUnit * Math.cos(view.tilt ?? 0)
    ).toBeCloseTo(600);
    const world = new Vector3(40, -30, paperThickness);
    const projected = world.clone().project(camera);
    const point = chart.chartPoint({
      clientX: ((projected.x + 1) / 2) * 800,
      clientY: ((1 - projected.y) / 2) * 600,
    });
    expect(point?.x).toBeCloseTo(world.x);
    expect(point?.y).toBeCloseTo(world.y);
    expect(point?.z).toBeCloseTo(world.z);
  }
  const saved = chart.captureView();
  chart.setPresentation(0);
  chart.restoreView(saved);
  expect(chart.captureView()).toEqual(saved);
  expect(chart.view().tilt).toBeCloseTo(dioramaTilt);
  // A pre-transition saved view keeps the current orientation.
  chart.restoreView({ pixels: saved.pixels, x: 10, y: 20 });
  expect(chart.captureView().presentation).toBe(1);
  chart.setPresentation(Number.NaN);
  expect(chart.captureView().presentation).toBe(1);
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

it("animates continuously, ignores repeated destinations, and cancels obsolete motion on restore and disposal", async () => {
  const clock = animationClock();
  const { chart } = await build(false);
  chart.setPresentation(1);
  clock.step(325);
  expect(chart.view().presentation).toBeCloseTo(0.5);
  chart.setPresentation(1);
  clock.step(325);
  expect(chart.view().presentation).toBe(1);
  expect(clock.pending()).toBe(0);
  const saved = chart.captureView();
  chart.setPresentation(0);
  clock.step(200);
  expect(chart.view().presentation).toBeLessThan(1);
  chart.restoreView(saved);
  expect(clock.pending()).toBe(0);
  clock.step(650);
  expect(chart.view().presentation).toBe(1);
  chart.setPresentation(0);
  expect(clock.pending()).toBe(1);
  chart.dispose();
  dispose = undefined;
  expect(clock.pending()).toBe(0);
  clock.step(650);
  expect(chart.view().presentation).toBe(1);
});

it("allows focusing and zooming during the camera transition without restoring an obsolete angle", async () => {
  const clock = animationClock();
  const { chart, territory } = await build(false);
  chart.setPresentation(1);
  clock.step(200);
  chart.focus({ file: undefined, target: new Vector3(20, 30, 0), territory });
  clock.step(200);
  const partial = chart.view().presentation ?? 0;
  expect(partial).toBeGreaterThan(0);
  chart.zoom(1.1);
  clock.step(450);
  expect(chart.view().presentation).toBe(1);
  const forward = chart.camera.getWorldDirection(new Vector3());
  expect(forward.y).toBeCloseTo(Math.sin(dioramaTilt));
  expect(forward.z).toBeCloseTo(-Math.cos(dioramaTilt));
  expect(clock.pending()).toBe(0);
});
