// @vitest-environment happy-dom
import assert from "node:assert/strict";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { inkStyle } from "../../src/web/scene/ink-ladder";
import { createAtlasScene } from "../../src/web/scene/scene";
import { inspectionText } from "../../src/web/ui/atlas-place";
import Atlas from "../../src/web/ui/atlas-view";
import { loadAtlas } from "../helpers/reference-atlas";

vi.mock("../../src/web/scene/dive-scene", () => ({
  createDiveScene: vi.fn(() => ({ configure: vi.fn(), dispose: vi.fn() })),
}));
vi.mock("../../src/web/scene/scene", () => ({
  createAtlasScene: vi.fn((host: HTMLElement) => {
    const canvas = document.createElement("canvas");
    host.append(canvas);
    return {
      captureView: vi.fn(() => ({ pixels: 2, x: 10, y: 20 })),
      configure: vi.fn(),
      dispose: vi.fn(() => canvas.remove()),
      focus: vi.fn(),
      focusWreck: vi.fn(),
      getRenderStatus: vi.fn(() => ({
        adapted: false,
        backend: "webgl" as const,
        failure: null,
        frameMs: null,
        globalIlluminationAvailable: false,
        postProcessing: true,
        quality: "medium" as const,
      })),
      pinRegion: vi.fn(),
      restoreView: vi.fn(),
      setBelonging: vi.fn(),
      setConnections: vi.fn(),
      setLegendHeight: vi.fn(),
      setResponsibility: vi.fn(),
      setTerritoryLayout: vi.fn(),
      zoom: vi.fn(),
    };
  }),
}));

let root: Root;
let container: HTMLDivElement;
beforeEach(() => {
  Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", {
    configurable: true,
    value: true,
    writable: true,
  });
  Object.defineProperty(document, "fonts", {
    configurable: true,
    value: { load: vi.fn().mockResolvedValue([]) },
  });
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    value: vi.fn(() => ({
      addEventListener: vi.fn(),
      matches: false,
      removeEventListener: vi.fn(),
    })),
  });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(() => root.unmount());
  container.remove();
});

function button(name: string): HTMLButtonElement {
  const match = [...container.querySelectorAll("button")].find(
    (element) =>
      element.textContent?.trim() === name ||
      element.getAttribute("aria-label") === name
  );
  assert(match, `Missing button ${name}`);
  return match;
}

function panel(): HTMLElement | null {
  return container.querySelector("#atlas-panel");
}

function pressEscape() {
  window.dispatchEvent(
    new KeyboardEvent("keydown", { cancelable: true, key: "Escape" })
  );
}

it("keeps every control in the header and starts with the panel closed", async () => {
  const data = await loadAtlas();
  await act(async () => {
    root.render(createElement(Atlas, { data }));
  });
  const header = container.querySelector("header.atlas-header");
  assert(header);
  expect(header.querySelector('[aria-label="Map controls"]')).not.toBeNull();
  for (const name of [
    "Zoom out",
    "Whole atlas",
    "Zoom in",
    "Chart settings",
    "Side panel",
    "Find a place",
  ]) {
    expect(header.contains(button(name))).toBe(true);
  }
  expect(container.querySelector(".atlas-map-bottom")).toBeNull();
  // The atmosphere, and its header toggle, are gone: the chart is still.
  expect(container.textContent).not.toContain("Decorative atmosphere");
  expect(panel()?.hidden).toBe(true);
  expect(container.querySelector('[aria-live="polite"]')).not.toBeNull();
});

it("starts on the belonging map layer and switches to files", async () => {
  const data = await loadAtlas();
  await act(async () => {
    root.render(createElement(Atlas, { data }));
  });
  const layer = container.querySelector<HTMLSelectElement>(
    'header.atlas-header label.atlas-map-layer select[aria-label="Map layer"]'
  );
  assert(layer, "Missing the map layer control");
  expect([...layer.options].map((option) => option.textContent)).toEqual([
    "Belonging",
    "Files",
  ]);
  expect(layer.value).toBe("belonging");
  await act(async () => {
    layer.value = "files";
    layer.dispatchEvent(new Event("change", { bubbles: true }));
  });
  expect(layer.value).toBe("files");
});

it("opens sections from the header, closes on Escape and returns focus", async () => {
  const data = await loadAtlas();
  await act(async () => {
    root.render(createElement(Atlas, { data }));
  });
  const chart = button("Chart settings");
  await act(async () => chart.click());
  expect(panel()?.hidden).toBe(false);
  expect(
    container.querySelector('[role="tab"][aria-selected="true"]')?.textContent
  ).toBe("Chart");
  expect(container.querySelector(".atlas-chart-settings")).not.toBeNull();
  expect(chart.getAttribute("aria-expanded")).toBe("true");
  // Two class tokens, so the wide layout's shift still applies to the world.
  expect(
    [...(container.querySelector(".atlas-world")?.classList ?? [])].sort()
  ).toEqual(["atlas-panel-open", "atlas-world"]);

  await act(async () => button("Find a place").click());
  expect(
    container.querySelector('[role="tab"][aria-selected="true"]')?.textContent
  ).toBe("Find");
  expect(document.activeElement).toBe(
    container.querySelector('input[type="search"]')
  );

  await act(async () => pressEscape());
  expect(panel()?.hidden).toBe(true);
  expect(document.activeElement).toBe(button("Find a place"));
  expect(container.querySelector('input[type="search"]')).toBeNull();
  expect(container.querySelector(".atlas-chart-settings")).toBeNull();

  await act(async () => button("Side panel").click());
  expect(panel()?.hidden).toBe(false);
  expect(
    container.querySelector('[role="tab"][aria-selected="true"]')?.textContent
  ).toBe("Find");
});

it("opens chart settings from the scene callback used by the painted compass", async () => {
  const data = await loadAtlas();
  await act(async () => {
    root.render(createElement(Atlas, { data }));
  });
  const onSettings = vi
    .mocked(createAtlasScene)
    .mock.calls.at(-1)?.[2].onSettings;
  assert(onSettings);
  await act(async () => onSettings());
  expect(panel()?.hidden).toBe(false);
  expect(
    container.querySelector('[role="tab"][aria-selected="true"]')?.textContent
  ).toBe("Chart");
});

it("lists former packages in a Wrecks section and opens a dive from it", async () => {
  const data = {
    ...(await loadAtlas()),
    formerPackages: [
      {
        id: "@foundry/retired",
        label: "retired",
        lastObserved: "2026-01-15T00:00:00.000Z",
        x: 0,
        y: 0,
      },
    ],
  };
  await act(async () => {
    root.render(createElement(Atlas, { data }));
  });
  await act(async () => button("Side panel").click());
  const tab = [...container.querySelectorAll('[role="tab"]')].find(
    (element) => element.textContent === "Wrecks 1"
  );
  assert(tab instanceof HTMLButtonElement);
  await act(async () => tab.click());
  expect(container.querySelector(".atlas-wreck-list")?.textContent).toContain(
    "@foundry/retired"
  );
  const wreck = container.querySelector<HTMLButtonElement>(
    '.atlas-wreck-list button[value="@foundry/retired"]'
  );
  assert(wreck);
  await act(async () => wreck.click());
  // The dive loads on first use, so give its module a moment to arrive.
  const dive = () =>
    container.querySelector(
      '[aria-label="Underwater view of @foundry/retired"]'
    );
  for (let attempt = 0; attempt < 20 && !dive(); attempt += 1) {
    await act(async () => {
      await new Promise((done) => setTimeout(done, 10));
    });
  }
  expect(dive()).not.toBeNull();
  expect(panel()?.hidden).toBe(true);
});

it("renders no chrome in map-only mode", async () => {
  const data = await loadAtlas();
  await act(async () => {
    root.render(createElement(Atlas, { data, mapOnly: true }));
  });
  expect(container.querySelector("header")).toBeNull();
  expect(panel()).toBeNull();
  expect(container.querySelector(".atlas-map-view")).not.toBeNull();
});

it("offers no playback, wind, current, waves, or water pigment in chart settings", async () => {
  const data = await loadAtlas();
  await act(async () => {
    root.render(createElement(Atlas, { data, developer: true }));
  });
  await act(async () => button("Chart settings").click());
  const settings = container.querySelector(".atlas-chart-settings");
  assert(settings);
  const headings = [...settings.querySelectorAll("summary, legend")].map(
    (heading) => heading.textContent
  );
  for (const gone of ["Playback", "Wind", "Current", "Waves"]) {
    expect(headings).not.toContain(gone);
  }
  expect(settings.querySelector('[aria-label="Water pigment"]')).toBeNull();
  expect(settings.querySelector('[aria-label="Timeline"]')).toBeNull();
});

/** The Chart section's headings and labelled controls, after opening it. */
async function chartSettings(developer: boolean) {
  const data = await loadAtlas();
  await act(async () => {
    root.render(createElement(Atlas, { data, developer }));
  });
  await act(async () => button("Chart settings").click());
  const settings = container.querySelector(".atlas-chart-settings");
  assert(settings);
  return {
    headings: [...settings.querySelectorAll("summary, h3")].map(
      (heading) => heading.textContent
    ),
    labels: [...settings.querySelectorAll("label")].map(
      (label) => label.textContent ?? ""
    ),
  };
}

it("shows a reader only the layers that carry data", async () => {
  const { headings, labels } = await chartSettings(false);
  expect(headings).toEqual(["Layers"]);
  expect(labels).toEqual([
    "Sea trade routes",
    "District streams",
    "Recorded change · evidence in Place",
    "Topographic lines",
  ]);
});

it("adds the developer's controls, without forests, houses, or map filters", async () => {
  const { headings, labels } = await chartSettings(true);
  expect(headings).toEqual([
    "Layers",
    "Developer",
    "Dependency, drawn again",
    "Display boundaries",
    "Rendering",
  ]);
  expect(labels).toContain("Connecting land");
  expect(labels).toContain("Road network");
  for (const gone of ["Houses", "Forests", "Map filter"]) {
    expect(labels.some((label) => label.includes(gone))).toBe(false);
  }
});

it("resets a reader's settings without building a new scene", async () => {
  const data = await loadAtlas();
  await act(async () => {
    root.render(createElement(Atlas, { data }));
  });
  await act(async () => button("Chart settings").click());
  const calls = vi.mocked(createAtlasScene).mock.calls.length;
  await act(async () => button("Reset visualization").click());
  expect(vi.mocked(createAtlasScene).mock.calls.length).toBe(calls);
});

it("keeps a two-row legend open, with a map key drawn from the ink table", async () => {
  const data = await loadAtlas();
  await act(async () => {
    root.render(createElement(Atlas, { data }));
  });
  const legend = container.querySelector('[aria-label="Legend"]');
  assert(legend);
  const rows = legend.querySelectorAll(".atlas-legend-row");
  expect(rows).toHaveLength(2);
  expect(rows[0]?.textContent).toContain(
    "Packages built on others north, the foundation south"
  );
  // File kinds in the map's shapes: a half-disc for story, a box for test.
  expect(rows[0]?.querySelectorAll("path")).toHaveLength(1);
  // Swatches are drawn 1:1: their viewBox is their size in pixels.
  for (const svg of legend.querySelectorAll("svg")) {
    expect(svg.getAttribute("viewBox")).toBe(
      `0 0 ${svg.getAttribute("width")} ${svg.getAttribute("height")}`
    );
  }
  expect(rows[1]?.textContent).toContain("Imports from");
  // The legend's rows are open without a click; the key below is collapsed.
  expect(legend.querySelector("details")?.open).toBe(false);
  const key = [...legend.querySelectorAll("dt")].map((row) => row.textContent);
  expect(key).toContain(`${inkStyle("trade").meaning} · off`);
  expect(key).toContain(inkStyle("marsh-drain").meaning);
  const [, imports] = rows[1]?.querySelectorAll("path") ?? [];
  expect(imports?.getAttribute("stroke-dasharray")).toBe(
    inkStyle("selection-imports").dash.join(" ")
  );
});

it("tells a screen reader an island's dependency layer, or that it has none", async () => {
  const data = await loadAtlas();
  const [territory] = data.territories;
  assert(territory);
  const read = (layers: Record<string, number | null>) =>
    inspectionText(null, { territory }, undefined, layers)?.detail ?? "";
  expect(read({ [territory.id]: 2 })).toContain("Layer 2");
  expect(read({ [territory.id]: null })).toContain("No layer");
  expect(read({})).toContain("No layer");
});
