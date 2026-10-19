// @vitest-environment happy-dom
import { Vector3 } from "three";
import { afterEach, expect, it, vi } from "vitest";
import { createChartCamera } from "../../src/web/scene/chart-camera";
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
});

async function build() {
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
    reducedMotion: { matches: true } as MediaQueryList,
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
  return { chart, file, resizeTo, territory };
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
