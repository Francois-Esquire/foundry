// @vitest-environment happy-dom
import assert from "node:assert/strict";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createAtlasScene } from "../../src/web/scene/scene";
import Atlas from "../../src/web/ui/atlas-view";
import { loadAtlas } from "../helpers/reference-atlas";

vi.mock("../../src/web/scene/dive-scene", () => ({
  createDiveScene: vi.fn(() => () => undefined),
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
      getPlayback: vi.fn(() => ({
        playing: true,
        speed: 1,
        time: 0,
        tracks: {
          current: { playing: true, time: 0 },
          waves: { playing: true, time: 0 },
          wind: { playing: true, time: 0 },
        },
      })),
      pinRegion: vi.fn(),
      play: vi.fn(),
      restorePlayback: vi.fn(),
      restoreView: vi.fn(),
      seek: vi.fn(),
      setAtmosphere: vi.fn(),
      setBelonging: vi.fn(),
      setConnections: vi.fn(),
      setPlaybackSpeed: vi.fn(),
      setResponsibility: vi.fn(),
      setTerritoryLayout: vi.fn(),
      setTrackPlaying: vi.fn(),
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
    "Decorative atmosphere",
    "Chart settings",
    "Side panel",
    "Find a place",
  ]) {
    expect(header.contains(button(name))).toBe(true);
  }
  expect(container.querySelector(".atlas-map-bottom")).toBeNull();
  expect(panel()?.hidden).toBe(true);
  expect(container.querySelector('[aria-live="polite"]')).not.toBeNull();
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
  const onSettings = vi.mocked(createAtlasScene).mock.calls.at(-1)?.[4];
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
  expect(
    container.querySelector(
      '[aria-label="Underwater view of @foundry/retired"]'
    )
  ).not.toBeNull();
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
