// @vitest-environment happy-dom
import assert from "node:assert/strict";
import { OrthographicCamera, Vector3 } from "three";
import { afterEach, expect, it, vi } from "vitest";
import { inks } from "../../src/web/ladder/ink-ladder";
import type { MapLabel } from "../../src/web/layout/labels";
import { flatMarkHeight } from "../../src/web/layout/terrain-height";
import type { LabelPlace } from "../../src/web/scene/handle";
import { createLabelsLayer } from "../../src/web/scene/labels/labels-layer";
import type { TextMetrics } from "../../src/web/scene/labels/measure";
import { createViewState } from "../../src/web/scene/view-state";
import { defaultChartSettings } from "../../src/web/settings/chart-settings";
import { chartTilt, inkView } from "../../src/web/view/chart-view";
import { twoIslands as data } from "../helpers/island-fixture";

/** A measure every test can predict: 0.55 em a character, the baseline 0.8 em down. */
const metrics: TextMetrics = {
  baseline: () => 0.8,
  dispose: vi.fn(),
  measure: (text) => text.length * 0.55,
};

const viewport = { height: 400, width: 600 };

/**
 * The chart's camera over a 600 × 400 viewport, tilted as the chart is, at a
 * zoom that gives the pixels per unit asked for; the view is read off it as
 * the scene reads its own.
 */
function cameraAt(pixelsPerUnit: number) {
  const span = viewport.width / pixelsPerUnit;
  const camera = new OrthographicCamera(
    -span / 2,
    span / 2,
    (span * viewport.height) / viewport.width / 2,
    (-span * viewport.height) / viewport.width / 2,
    1,
    10_000
  );
  camera.position.set(
    0,
    -Math.sin(chartTilt) * 2200,
    Math.cos(chartTilt) * 2200
  );
  camera.lookAt(0, 0, 0);
  camera.updateProjectionMatrix();
  camera.updateMatrixWorld();
  const view = inkView(
    camera,
    new Vector3(0, 0, 0),
    chartTilt,
    flatMarkHeight,
    viewport.width
  );
  /** A chart point (y south) at a height, on screen. */
  const screen = (x: number, y: number, z: number) => {
    const v = new Vector3(x, -y, z).project(camera);
    return {
      x: ((v.x + 1) / 2) * viewport.width,
      y: ((1 - v.y) / 2) * viewport.height,
    };
  };
  return { camera, screen, view };
}

function build(pixelsPerUnit: number) {
  const host = document.createElement("div");
  document.body.append(host);
  const { camera, screen, view } = cameraAt(pixelsPerUnit);
  const published: MapLabel[][] = [];
  const layer = createLabelsLayer({
    camera,
    host,
    metrics: () => metrics,
    pixelRatio: () => 1,
    publish: (labels) => published.push(labels),
  });
  const state = createViewState(data, defaultChartSettings);
  const root = host.querySelector("section");
  assert(root);
  return { host, layer, published, root, screen, state, view };
}

let dispose: (() => void) | undefined;
afterEach(() => {
  dispose?.();
  dispose = undefined;
  document.body.innerHTML = "";
});

it("builds the chart as a section of islands, names each for assistive technology, and shows a name only when it is placed", () => {
  const { host, layer, published, root, screen, state, view } = build(2);
  ({ dispose } = layer);
  expect(root.getAttribute("aria-label")).toBe("Chart");
  layer.update?.(view, state, 0);
  const islands = [...root.querySelectorAll(".spyglass-islands > li")];
  expect(islands.map((item) => item.getAttribute("aria-label"))).toEqual([
    "Island, package, 2 files",
    "Other, package, 0 files",
  ]);
  expect(islands.every((item) => item.getAttribute("tabindex") === "0")).toBe(
    true
  );
  // The island's name is placed; the other island's lies east of the view.
  const [placed] = published;
  assert(placed);
  expect(placed.map((each) => each.text)).toEqual(["Island"]);
  const names = islands.map((item) =>
    item.querySelector<HTMLElement>(".spyglass-island-name")
  );
  expect(names[0]?.hidden).toBe(false);
  expect(names[1]?.hidden).toBe(true);
  const [name] = names;
  const [label] = placed;
  assert(name && label);
  expect(name.textContent).toBe("Island2 FILES");
  expect(name.style.fontSize).toBe(`${label.height * 2}px`);
  expect(name.style.color).toBe(inks.label);
  // Lettered at its anchor's projection: the top-left is the baseline centre less half the width and the squashed baseline.
  const size = label.height * 2;
  const width = Math.max(
    label.width * 2,
    (label.caption?.length ?? 0) * 0.55 * 9.5
  );
  const anchor = screen(label.x, label.y, label.z);
  expect(name.style.transform).toBe(
    `translate(${Math.round(anchor.x - width / 2)}px, ${Math.round(anchor.y - Math.cos(chartTilt) * 0.8 * size)}px) scaleY(${Math.cos(chartTilt)})`
  );
  // Margin notes are hidden from assistive technology; the sea's caption and the compass letter are among them.
  const margin = root.querySelector("[aria-hidden=true]");
  assert(margin);
  expect(margin.querySelectorAll(".spyglass-reference").length).toBeGreaterThan(
    0
  );
  expect(margin.querySelector(".spyglass-compass-letter")?.textContent).toBe(
    "N"
  );
  expect(margin.querySelector(".spyglass-sea-caption-0")?.textContent).toBe(
    "The dependency sea"
  );
  // No layer is placed, so no scale is shown.
  expect(margin.querySelector<HTMLElement>(".spyglass-latitude")?.hidden).toBe(
    true
  );
  expect(host.contains(root)).toBe(true);
  layer.dispose();
  dispose = undefined;
  expect(host.contains(root)).toBe(false);
  expect(metrics.dispose).toHaveBeenCalled();
});

it("lists the files labelled on the selected island under it, removes them as they go, and selects what a focused item names on Enter", () => {
  const { layer, root, state, view } = build(5);
  ({ dispose } = layer);
  state.selected = "island";
  layer.update?.(view, state, 0);
  const island = root.querySelector(".spyglass-islands > li");
  assert(island);
  const items = [...island.querySelectorAll(".spyglass-island-labels > li")];
  expect(items.map((item) => item.getAttribute("aria-label"))).toEqual([
    "one.ts, file",
    "two.ts, file",
  ]);
  // Published before anything else reads them, each frame.
  expect(state.labels).toEqual([]);
  const places: LabelPlace[] = [];
  layer.setActivation((place) => places.push(place));
  const [one] = items;
  assert(one);
  one.dispatchEvent(
    new KeyboardEvent("keydown", { bubbles: true, key: "Enter" })
  );
  island.dispatchEvent(
    new KeyboardEvent("keydown", { bubbles: true, key: " " })
  );
  island.dispatchEvent(
    new KeyboardEvent("keydown", { bubbles: true, key: "a" })
  );
  expect(places).toEqual([
    {
      compositeId: undefined,
      file: data.territories[0]?.files[0],
      regionId: undefined,
      territory: data.territories[0],
    },
    { territory: data.territories[0] },
  ]);
  // Deselected, the files are no longer named, and their items go; the island's item stays.
  const before = one;
  state.selected = null;
  layer.update?.(view, state, 0);
  expect(island.querySelectorAll(".spyglass-island-labels > li")).toHaveLength(
    0
  );
  expect(root.contains(before)).toBe(false);
  expect(root.contains(island)).toBe(true);
  // Named again, the same item is kept rather than made anew.
  state.selected = "island";
  layer.update?.(view, state, 0);
  const again = island.querySelector(".spyglass-island-labels > li");
  expect(again?.getAttribute("aria-label")).toBe("one.ts, file");
  layer.update?.(view, state, 0);
  expect(island.querySelector(".spyglass-island-labels > li")).toBe(again);
});

it("sets the latitude scale in the margin, with a tick and a number for each placed layer", () => {
  const { layer, root, state, view } = build(1);
  ({ dispose } = layer);
  state.drawingData = { ...data, packageLayers: { island: 0, other: 0 } };
  layer.update?.(view, state, 0);
  const scale = root.querySelector<HTMLElement>(".spyglass-latitude");
  assert(scale);
  expect(scale.hidden).toBe(false);
  expect(scale.querySelectorAll("line")).toHaveLength(2);
  expect(scale.querySelector(".spyglass-latitude-label")?.textContent).toBe(
    "FOUNDATION · 0"
  );
  expect(scale.style.opacity).toBe("1");
});
