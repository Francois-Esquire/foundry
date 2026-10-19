// @vitest-environment happy-dom
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { OrthographicCamera, Vector3 } from "three";
import { afterEach, expect, it, vi } from "vitest";
import { inks } from "../../src/web/ladder/ink-ladder";
import type { MapLabel } from "../../src/web/layout/labels";
import { flatMarkHeight } from "../../src/web/layout/terrain-height";
import type { LabelPlace } from "../../src/web/scene/handle";
import { createViewState } from "../../src/web/scene/view-state";
import { defaultChartSettings } from "../../src/web/settings/chart-settings";
import { ChartChrome } from "../../src/web/ui/chart-chrome";
import {
  type ChartChromeModel,
  createChromePresenter,
} from "../../src/web/ui/chart-chrome-model";
import { gridReferences } from "../../src/web/ui/chart-margin-layout";
import { createLabelsLayer } from "../../src/web/ui/map-labels/labels-layer";
import {
  createTextMetrics,
  type TextMetrics,
} from "../../src/web/ui/map-labels/measure";
import { chartTilt, inkView } from "../../src/web/view/chart-view";
import { twoIslands as data, ownRelief } from "../helpers/island-fixture";
import { recordStyleWrites } from "../helpers/style-writes";

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
  const chrome = document.createElement("div");
  document.body.append(chrome);
  const models: ChartChromeModel[] = [];
  const present = createChromePresenter((model) => {
    models.push(model);
    chrome.innerHTML = renderToStaticMarkup(
      createElement(ChartChrome, { model })
    );
  });
  const labelLayer = createLabelsLayer({
    camera,
    host,
    metrics: () => metrics,
    pixelRatio: () => 1,
    present,
    publish: (labels) => published.push(labels),
    reliefOf: ownRelief,
  });
  const layer = {
    ...labelLayer,
    update(
      nextView: Parameters<NonNullable<typeof labelLayer.update>>[0],
      nextState: Parameters<NonNullable<typeof labelLayer.update>>[1],
      time: number
    ) {
      labelLayer.updateAnnotations?.(nextView, nextState, time);
      labelLayer.update?.(nextView, nextState, time);
    },
  };
  const state = createViewState(data, defaultChartSettings);
  const root = host.querySelector("section");
  assert(root);
  return {
    camera,
    chrome,
    host,
    layer,
    models,
    published,
    root,
    screen,
    state,
    view,
  };
}

let dispose: (() => void) | undefined;
afterEach(() => {
  dispose?.();
  dispose = undefined;
  document.body.innerHTML = "";
});

it("builds the chart as a section of islands, names each for assistive technology, and shows a name only when it is placed", () => {
  const { host, layer, published, root, screen, state, view, chrome } =
    build(2);
  ({ dispose } = layer);
  expect(root.getAttribute("aria-label")).toBe("Chart");
  expect(layer.id).toBe("labels");
  expect(layer.kind).toBe("labels");
  // The stylesheet scopes every label rule to this class: the layer's
  // class names are plain words the sheets use for prose too.
  expect(root.className).toBe("spyglass-labels");
  layer.update(view, state, 0);
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
  assert(name && label?.kind === "island");
  expect(name.textContent).toBe("Island2 FILES");
  expect(name.style.fontSize).toBe(`${label.height * 2}px`);
  expect(name.style.color).toBe(inks.label);
  // Lettered at its anchor's projection: the top-left is the baseline centre less half the width and the squashed baseline.
  const size = label.height * 2;
  const width = Math.max(label.width * 2, label.caption.length * 0.55 * 9.5);
  const anchor = screen(label.x, label.y, label.z);
  expect(name.style.transform).toBe(
    `translate(${Math.round(anchor.x - width / 2)}px, ${Math.round(anchor.y - Math.cos(chartTilt) * 0.8 * size)}px) scaleY(${Math.cos(chartTilt)})`
  );
  // Margin notes are hidden from assistive technology; the sea's caption is among them.
  const margin = chrome.querySelector(".spyglass-margin");
  assert(margin);
  expect(margin.querySelectorAll(".spyglass-reference").length).toBeGreaterThan(
    0
  );
  const reference = margin.querySelector<SVGTextElement>(".spyglass-reference");
  expect(reference?.style.fontSize).toBe("12px");
  expect(reference?.style.fontFamily).toContain("SpyglassDisplay");
  expect(reference?.getAttribute("fill")).toBe("black");
  const outline = margin.querySelector<SVGTextElement>(
    ".spyglass-reference-outline"
  );
  expect(outline?.textContent).toBe(reference?.textContent);
  expect(outline?.getAttribute("fill")).toBe("none");
  expect(outline?.getAttribute("x")).toBe(reference?.getAttribute("x"));
  expect(outline?.getAttribute("y")).toBe(reference?.getAttribute("y"));
  const mask = reference?.closest("mask");
  assert(mask);
  expect(
    margin
      .querySelector(".spyglass-frame-panels")
      ?.parentElement?.getAttribute("mask")
  ).toBe(`url(#${mask.id})`);
  expect(mask.querySelector("rect")?.getAttribute("fill")).toBe("white");
  expect(margin.querySelector(".spyglass-compass-letter")).toBeNull();
  expect(margin.querySelector(".spyglass-sea-caption-0")?.textContent).toBe(
    "The dependency sea"
  );
  // No layer is placed, so no scale is shown.
  expect(margin.querySelector(".spyglass-latitude")).toBeNull();
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
  layer.update(view, state, 0);
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
  // Deselected, the files are no longer named, and their items go; the
  // island's item stays, and takes the focus of the item that went.
  const before = one;
  assert(before instanceof HTMLElement && island instanceof HTMLElement);
  before.focus();
  expect(document.activeElement).toBe(before);
  state.selected = null;
  layer.update(view, state, 0);
  expect(island.querySelectorAll(".spyglass-island-labels > li")).toHaveLength(
    0
  );
  expect(root.contains(before)).toBe(false);
  expect(root.contains(island)).toBe(true);
  expect(document.activeElement).toBe(island);
  // Named again, the same item is kept rather than made anew.
  state.selected = "island";
  layer.update(view, state, 0);
  const again = island.querySelector(".spyglass-island-labels > li");
  expect(again?.getAttribute("aria-label")).toBe("one.ts, file");
  layer.update(view, state, 0);
  expect(island.querySelector(".spyglass-island-labels > li")).toBe(again);
});

it("sets the latitude scale in the margin, with a tick and a number for each placed layer", () => {
  const { layer, chrome, state, view } = build(1);
  ({ dispose } = layer);
  state.drawingData = { ...data, packageLayers: { island: 0, other: 0 } };
  layer.update(view, state, 0);
  const scale = chrome.querySelector<HTMLElement>(".spyglass-latitude");
  assert(scale);
  expect(scale).not.toBeNull();
  expect(scale.querySelectorAll("line")).toHaveLength(2);
  expect(scale.querySelector(".spyglass-latitude-label")?.textContent).toBe(
    "FOUNDATION · 0"
  );
  expect(scale.style.opacity).toBe("1");
});

/** The styles that hold from frame to frame: written when an element is made, and again only when the font, the ink or the halo changes. */
const staticStyles = new Set([
  "color",
  "fontFamily",
  "fontStyle",
  "letterSpacing",
  "webkitTextStroke",
]);

const statics = (writes: string[]) =>
  writes.filter((property) => staticStyles.has(property));

it("writes an element's static styles once, and again only when its ink changes; a still frame writes none", () => {
  const { layer, root, state, view } = build(5);
  ({ dispose } = layer);
  state.selected = "island";
  layer.update(view, state, 0);
  const name = root.querySelector<HTMLElement>(".spyglass-island-name");
  const item = root.querySelector<HTMLElement>(".spyglass-island-labels > li");
  assert(name && item);
  expect(item.style.color).toBe(inks.label);
  const nameWrites = recordStyleWrites(name);
  const itemWrites = recordStyleWrites(item);
  // A still frame moves and sizes the elements, and letters none again.
  layer.update(view, state, 0);
  expect(itemWrites).toEqual(["opacity", "fontSize", "transform"]);
  expect(statics(nameWrites)).toEqual([]);
  // The file selected, its name takes the selection's ink and a wider halo; the island's name is as it was.
  state.selectedFile = "one";
  layer.update(view, state, 0);
  expect(item.style.color).toBe(inks.selection);
  expect(statics(itemWrites)).toEqual([
    "fontFamily",
    "fontStyle",
    "letterSpacing",
    "color",
    "webkitTextStroke",
  ]);
  expect(statics(nameWrites)).toEqual([]);
});

it("keeps coordinate cutouts when a placed island name overlaps them", () => {
  const { layer, chrome, state, view, published } = build(2);
  ({ dispose } = layer);
  const target = gridReferences(view, data).find(
    (reference) => reference.edge === "top"
  );
  assert(target);
  const [original] = data.territories;
  assert(original);
  const territory = { ...original, x: target.x, y: target.y + 24 };
  state.drawingData = { ...data, territories: [territory] };
  layer.update(view, state, 0);
  const placed = published.at(-1) ?? [];
  const name = placed.find((label) => label.text === territory.label);
  assert(name);
  expect(name.x - name.width / 2).toBeLessThan(target.x);
  expect(name.x + name.width / 2).toBeGreaterThan(target.x);
  expect(name.y - name.height).toBeLessThan(target.y);
  expect(name.y).toBeGreaterThan(target.y);
  const letters = [...chrome.querySelectorAll("mask .spyglass-reference")].map(
    (element) => element.textContent
  );
  expect(letters).toContain(target.text);
});

it("publishes chrome props only when its view, chart or margin inputs change", () => {
  const { camera, layer, state, view, models } = build(2);
  ({ dispose } = layer);
  layer.update(view, state, 0);
  const [first] = models;
  assert(first);
  const [coordinate] = first.coordinates;
  assert(coordinate);
  const originalX = coordinate.x;
  layer.update(view, state, 1);
  state.selectedFile = "one";
  layer.update(view, state, 2);
  expect(models).toHaveLength(1);
  state.legendHeight = 200;
  layer.update(view, state, 3);
  expect(models).toHaveLength(2);
  camera.position.x += 10;
  layer.update(view, state, 4);
  expect(models).toHaveLength(3);
  expect(models[2]?.coordinates[0]?.x).not.toBe(originalX);
  expect(first.coordinates[0]?.x).toBe(originalX);
});

it("isolates labels from chrome, clears hit boxes and keyboard activation, and restores an unchanged view", () => {
  const { layer, root, published, state, view, chrome } = build(5);
  ({ dispose } = layer);
  state.selected = "island";
  state.selectedFile = "one";
  layer.update(view, state, 0);
  const before = published.at(-1);
  expect(before?.length).toBeGreaterThan(0);
  const item = root.querySelector<HTMLElement>(".spyglass-island-labels > li");
  assert(item);
  item.focus();
  const activate = vi.fn();
  layer.setActivation(activate);
  layer.setVisible?.(false);
  expect(root.hidden).toBe(true);
  expect(root.inert).toBe(true);
  expect(document.activeElement).not.toBe(item);
  expect(published.at(-1)).toEqual([]);
  item.dispatchEvent(
    new KeyboardEvent("keydown", { bubbles: true, key: "Enter" })
  );
  expect(activate).not.toHaveBeenCalled();
  layer.update(view, state, 1);
  expect(published.at(-1)).toEqual([]);
  expect(chrome.querySelector(".spyglass-frame-rule")).not.toBeNull();
  expect(state.selected).toBe("island");
  expect(state.selectedFile).toBe("one");
  layer.setVisible?.(true);
  layer.update(view, state, 2);
  expect(root.hidden).toBe(false);
  expect(root.inert).toBe(false);
  expect(published.at(-1)).toEqual(before);
  item.dispatchEvent(
    new KeyboardEvent("keydown", { bubbles: true, key: "Enter" })
  );
  expect(activate).toHaveBeenCalledOnce();
});

it("isolates frame, coordinates, scale and sea captions independently while labels stay hidden", () => {
  const { layer, state, view, chrome } = build(1);
  ({ dispose } = layer);
  state.drawingData = { ...data, packageLayers: { island: 0, other: 0 } };
  layer.setVisible?.(false);
  for (const [id, selector] of [
    ["chart-frame", ".spyglass-frame-rule"],
    ["coordinates", ".spyglass-reference-outline"],
    ["latitude-scale", ".spyglass-latitude"],
    ["sea-caption", ".spyglass-sea-caption-0"],
  ] as const) {
    state.settings = {
      ...state.settings,
      composition: { hidden: [], solo: [id] },
    };
    layer.updateAnnotations?.(view, state, 0);
    expect(chrome.querySelector(selector)).not.toBeNull();
    state.settings = {
      ...state.settings,
      composition: { hidden: [], solo: ["sea"] },
    };
    layer.updateAnnotations?.(view, state, 0);
    expect(chrome.querySelector(selector)).toBeNull();
    state.settings = {
      ...state.settings,
      composition: { hidden: [], solo: [id] },
    };
    layer.updateAnnotations?.(view, state, 0);
    expect(chrome.querySelector(selector)).not.toBeNull();
  }
});

it("keeps text measurement outside the hidden label tree for independent chrome updates", () => {
  const host = document.createElement("div");
  document.body.append(host);
  const { camera, view } = cameraAt(1);
  let actualMetrics: TextMetrics | undefined;
  const readBounds = vi
    .spyOn(HTMLElement.prototype, "getBoundingClientRect")
    .mockImplementation(function (this: HTMLElement) {
      return {
        bottom: 80,
        height: 100,
        left: 0,
        right: 100,
        toJSON: () => ({}),
        top: 0,
        width: this.closest("[hidden]") ? 0 : 100,
        x: 0,
        y: 0,
      };
    });
  try {
    const layer = createLabelsLayer({
      camera,
      host,
      metrics: (measurementHost) => {
        actualMetrics = createTextMetrics(measurementHost);
        return actualMetrics;
      },
      pixelRatio: () => 1,
      publish: vi.fn(),
      reliefOf: ownRelief,
    });
    ({ dispose } = layer);
    const state = createViewState(data, defaultChartSettings);
    layer.setVisible?.(false);
    const probe = host.querySelector(".spyglass-measure");
    assert(probe && actualMetrics);
    expect(host.querySelector("section")?.hidden).toBe(true);
    expect(probe.closest("[hidden]")).toBeNull();
    expect(
      actualMetrics.measure("new chrome text", {
        face: "SpyglassDisplay",
        letterSpacing: 0,
      })
    ).toBe(1);
    layer.updateAnnotations?.(view, state, 0);
    layer.setVisible?.(true);
    expect(
      actualMetrics.measure("new chrome text", {
        face: "SpyglassDisplay",
        letterSpacing: 0,
      })
    ).toBe(1);
    layer.dispose();
    dispose = undefined;
    expect(host.children).toHaveLength(0);
  } finally {
    readBounds.mockRestore();
  }
});
