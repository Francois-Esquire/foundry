// @vitest-environment happy-dom
import assert from "node:assert/strict";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { LateCodex } from "../../src/web/codex/vocabulary";
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
      setData: vi.fn(),
      setDomain: vi.fn(),
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

/** An island's folder, then its layer, as Place reads them. */
const islandPlacement = / · packages\/agents · Layer 2 · /;

it("tells a screen reader what places an island: its folder and its dependency layer, or that it has none", async () => {
  const data = await loadAtlas();
  const [territory] = data.territories;
  assert(territory);
  const read = (packageLayers: Record<string, number | null>) =>
    inspectionText(null, { territory }, undefined, { ...data, packageLayers })
      ?.detail ?? "";
  expect(read({ [territory.id]: 2 })).toContain("Layer 2");
  // The folder orders the island's row; the layer is the row.
  expect(read({ [territory.id]: 2 })).toMatch(islandPlacement);
  expect(read({ [territory.id]: null })).toContain("No layer");
  expect(read({})).toContain("No layer");
});

it("tells a screen reader what places a file: its folder, and once read, its district", async () => {
  const data = await loadAtlas();
  const [territory] = data.territories;
  assert(territory);
  const file = territory.files.find((f) => f.directory.includes("/src/"));
  assert(file);
  const folder = file.directory.slice(territory.folder.length + 1);
  const district = {
    color: "#000",
    id: "responsibility-group:0123456789ab",
    label: "Sessions",
    members: [file],
    polygons: [],
    uncertain: false,
  };
  const read = (districts?: ReadonlyMap<string, typeof district>) =>
    inspectionText(null, { file, territory }, undefined, data, { districts })
      ?.detail ?? "";
  // Position means folder; until the island's belonging is read, no district.
  expect(read()).toContain(` · in ${folder} · `);
  expect(read()).not.toContain("district");
  expect(read(new Map([[file.id, district]]))).toContain(
    ` · in ${folder} · district Sessions · `
  );
});

it("tells where a place is used: a file departing, its symbol fitting, a package used by none", async () => {
  const data = await loadAtlas();
  const [territory, other] = data.territories;
  assert(territory && other);
  const file = territory.files.find((f) => f.directory.includes("/src/"));
  assert(file);
  const placed = (
    place: string,
    label: "departs" | "fits",
    home: number,
    away: number
  ) => ({
    away: [{ modules: away, package: other.id }],
    home,
    label,
    level: "file" as const,
    package: territory.id,
    place,
    share: label === "departs" ? away / (home + away) : home / (home + away),
    ...(label === "departs" ? { toward: other.id } : {}),
    unindexed: 0,
  });
  const atlas = {
    ...data,
    placement: {
      dominantShare: 0.6,
      labelled: [territory.id],
      places: {
        [`file:${file.path}`]: placed(file.path, "departs", 1, 3),
        [`symbol:${file.path}#run`]: {
          ...placed(`${file.path}#run`, "fits", 4, 1),
          level: "symbol" as const,
        },
      },
    },
  };
  const read = (selection: Parameters<typeof inspectionText>[1]) =>
    inspectionText(null, selection, undefined, atlas)?.detail ?? "";
  expect(read({ file, territory })).toContain(
    ` · placement: departs toward ${other.label} · 3 of 4 consumer modules · `
  );
  expect(
    read({ file, symbol: { id: `${file.path}#run`, name: "run" }, territory })
  ).toContain(" · placement: fits · 4 of 5 consumer modules at home · ");
  // A labelled package absent from the lens is used by no other package.
  expect(read({ territory })).toContain(
    " · placement: used by no other package · "
  );
  // A package the lens could not label says nothing of its use.
  expect(read({ territory: other })).not.toContain("placement");
});

it("adds a departure row to the legend with its totals, and the threshold, cap, and consumers left out to the map key", async () => {
  const data = await loadAtlas();
  const [territory, other] = data.territories;
  assert(territory && other);
  const [file] = territory.files;
  assert(file);
  const departing = {
    ...data,
    placement: {
      dominantShare: 0.6,
      labelled: [territory.id],
      places: {
        [`file:${file.path}`]: {
          away: [{ modules: 1, package: other.id }],
          home: 0,
          label: "departs" as const,
          level: "file" as const,
          package: territory.id,
          place: file.path,
          share: 1,
          toward: other.id,
          unindexed: 0,
        },
      },
    },
  };
  await act(async () => {
    root.render(createElement(Atlas, { data: departing }));
  });
  const rows = container.querySelectorAll(
    '[aria-label="Legend"] .atlas-legend-row'
  );
  expect(rows).toHaveLength(3);
  const row = rows[2]?.textContent ?? "";
  expect(row).toContain(inkStyle("departure").meaning);
  expect(row).toContain(inkStyle("departure-line").meaning);
  // One consumer module is too thin for a line: it counts, and is not drawn.
  expect(row).toContain("1 departing · 0 symbols in Place · 0 of 1 line");
  // Why, in the map key: the threshold, the cap, and the consumers left out.
  const key = container.querySelector(".atlas-map-key")?.textContent ?? "";
  expect(key).toContain("at least 2 of those modules");
  expect(key).toContain("at most 3 run into one package");
  expect(key).toContain("Consumers in no package of the scan are not counted");
});

it("tells what sits related but apart, and close but unrelated, for a file and its package", async () => {
  const data = await loadAtlas();
  const [territory, other] = data.territories;
  assert(territory && other);
  const [file, partner] = territory.files.filter((f) =>
    f.directory.includes("/src/")
  );
  const [far] = other.files;
  assert(file && partner && far);
  const atlas = {
    ...data,
    proximity: {
      apart: {
        coChanges: [
          {
            coChangeCommits: 6,
            distance: 2,
            id: `${file.path}|${partner.path}`,
            jaccard: 0.5,
            left: file.path,
            right: partner.path,
            scope: "same-package" as const,
            staticPath: "none" as const,
          },
          {
            coChangeCommits: 2,
            distance: 4,
            id: `${file.path}|${far.path}`,
            jaccard: 0.2,
            left: file.path,
            right: far.path,
            scope: "cross-package" as const,
            staticPath: "direct" as const,
          },
        ],
        files: [
          {
            distance: 2,
            file: file.path,
            folder: file.directory,
            package: territory.id,
            responsibility: "responsibility:r",
            responsibilityFolder: `${territory.folder}/src`,
          },
        ],
      },
      close: [
        {
          folder: file.directory,
          groups: [
            { apart: [], files: [file.path], responsibilities: ["a"] },
            { apart: [], files: [partner.path], responsibilities: ["b"] },
          ],
          package: territory.id,
          unresolved: 0,
        },
      ],
      labelled: [territory.id],
    },
  };
  const read = (selection: Parameters<typeof inspectionText>[1]) =>
    inspectionText(null, selection, undefined, atlas)?.detail ?? "";
  const partnerName = partner.path.split("/").at(-1);
  expect(read({ file, territory })).toContain(
    `proximity: apart from its responsibility's folder src · 2 steps; changes with ${partnerName} · 6 commits, no import path, and 1 more; its folder holds 2 unrelated groups of responsibilities`
  );
  expect(read({ territory })).toContain(
    "proximity: 1 close but unrelated, 1 apart, 2 co-changing pairs · 2 of 2 ties drawn"
  );
  // A package the lens did not cover says nothing of proximity.
  expect(read({ territory: other })).not.toContain("proximity");
});

it("tells a departure in a domain as two, the placement's and the domain's, and says when no domain is declared", async () => {
  const data = await loadAtlas();
  const [territory, other] = data.territories;
  assert(territory && other);
  const [file] = territory.files;
  assert(file);
  const atlas = {
    ...data,
    domains: {
      declared: [
        {
          name: "shapes",
          parents: [],
          places: [{ kind: "file" as const, place: file.path }],
          unmatched: [],
        },
      ],
      placements: {
        [`file:${file.path}`]: {
          away: { shared: 1, total: 3, unindexed: 0 },
          domainLabel: "departs" as const,
          domains: ["shapes"],
          level: "file" as const,
          package: territory.id,
          place: file.path,
          placementLabel: "departs" as const,
          sharedDomains: ["shapes"],
        },
      },
    },
    placement: {
      dominantShare: 0.6,
      labelled: [territory.id],
      places: {
        [`file:${file.path}`]: {
          away: [{ modules: 3, package: other.id }],
          home: 0,
          label: "departs" as const,
          level: "file" as const,
          package: territory.id,
          place: file.path,
          share: 1,
          toward: other.id,
          unindexed: 0,
        },
      },
    },
  };
  const detail =
    inspectionText(null, { file, territory }, undefined, atlas)?.detail ?? "";
  expect(detail).toContain(" · domains: shapes");
  expect(detail).toContain(
    `placement departure: toward ${other.label} · 3 of 3 consumer modules · domain departure: 1 of 3 consumer modules in other packages share its domains`
  );
  await act(async () => {
    root.render(createElement(Atlas, { data }));
  });
  expect(container.querySelector(".atlas-map-key")?.textContent).toContain(
    "No domains are declared."
  );
});

it("chooses a domain in Find, tells it in Place above the selection, keeps it while places are selected, and puts it away with Clear or Escape", async () => {
  const data = await loadAtlas();
  const [territory] = data.territories;
  assert(territory);
  const [file] = territory.files;
  assert(file);
  // Selecting an island reads its belonging; this test needs none of it.
  vi.stubGlobal(
    "fetch",
    vi.fn(() => new Promise(() => undefined))
  );
  await act(async () => {
    root.render(createElement(Atlas, { data }));
  });
  // With none declared, Find asks for islands only and lists no domain.
  await act(async () => button("Find a place").click());
  expect(
    container.querySelector<HTMLInputElement>('input[type="search"]')
      ?.placeholder
  ).toBe("Find an island…");
  expect(container.querySelector('.atlas-index button[value="shapes"]')).toBe(
    null
  );
  await act(() => root.unmount());
  root = createRoot(container);
  const declared = {
    ...data,
    domains: {
      declared: [
        {
          name: "shapes",
          parents: [],
          places: [{ kind: "file" as const, place: file.path }],
          reason: "Geometry",
          unmatched: [],
        },
      ],
      placements: {},
    },
  };
  await act(async () => {
    root.render(createElement(Atlas, { data: declared }));
  });
  const [result] = vi.mocked(createAtlasScene).mock.results.slice(-1);
  assert(result);
  const scene = await result.value;
  await act(async () => button("Find a place").click());
  expect(
    container.querySelector<HTMLInputElement>('input[type="search"]')
      ?.placeholder
  ).toBe("Find an island or domain…");
  const entry = container.querySelector<HTMLButtonElement>(
    '.atlas-index button[value="shapes"]'
  );
  assert(entry);
  expect(entry.getAttribute("aria-pressed")).toBe("false");
  expect(
    entry.querySelector(".atlas-swatch")?.getAttribute("aria-hidden")
  ).toBe("true");
  await act(async () => entry.click());
  expect(scene.setDomain).toHaveBeenLastCalledWith("shapes");
  expect(
    container.querySelector('[role="tab"][aria-selected="true"]')?.textContent
  ).toBe("Place");
  const told = container.querySelector('[aria-label="Chosen domain"]');
  expect(told?.textContent).toContain("Domain shapes");
  expect(told?.textContent).toContain("Geometry");
  expect(told?.textContent).toContain(
    `covers 1 file on 1 island: ${territory.label}`
  );
  // Selecting an island keeps the domain; Place tells both.
  await act(async () => button("Find a place").click());
  const island = container.querySelector<HTMLButtonElement>(
    `.atlas-index button[value="${territory.id}"]`
  );
  assert(island);
  await act(async () => island.click());
  expect(scene.setDomain).toHaveBeenLastCalledWith("shapes");
  expect(container.querySelector('[aria-label="Chosen domain"]')).not.toBe(
    null
  );
  expect(container.querySelector(".atlas-place h2")?.textContent).toBe(
    territory.label
  );
  // A real heading, under the selection's; the swatch is hidden from readers.
  expect(
    container.querySelector('[aria-label="Chosen domain"] h3')?.textContent
  ).toBe("Domain shapes");
  await act(async () => button("Clear domain").click());
  expect(scene.setDomain).toHaveBeenLastCalledWith(null);
  expect(container.querySelector('[aria-label="Chosen domain"]')).toBe(null);
  // Focus goes to Place's heading, not the page.
  expect(document.activeElement).toBe(
    container.querySelector(".atlas-place h2")
  );
  // Escape leaves the selection first, then puts the domain away.
  await act(async () => button("Find a place").click());
  const again = container.querySelector<HTMLButtonElement>(
    '.atlas-index button[value="shapes"]'
  );
  assert(again);
  await act(async () => again.click());
  expect(scene.setDomain).toHaveBeenLastCalledWith("shapes");
  await act(async () => pressEscape());
  expect(scene.setDomain).toHaveBeenLastCalledWith("shapes");
  await act(async () => pressEscape());
  expect(scene.setDomain).toHaveBeenLastCalledWith(null);
  expect(container.textContent).toContain(
    "1 domain is declared. Choose one in Find"
  );
  vi.unstubAllGlobals();
});

it("keeps the chosen domain through a relayout, handing it to the rebuilt scene", async () => {
  const data = await loadAtlas();
  const [territory] = data.territories;
  assert(territory);
  const declared = {
    ...data,
    domains: {
      declared: [
        {
          name: "shapes",
          parents: [],
          places: [{ kind: "package" as const, place: territory.folder }],
          unmatched: [],
        },
      ],
      placements: {},
    },
  };
  await act(async () => {
    root.render(createElement(Atlas, { data: declared, developer: true }));
  });
  await act(async () => button("Find a place").click());
  const entry = container.querySelector<HTMLButtonElement>(
    '.atlas-index button[value="shapes"]'
  );
  assert(entry);
  await act(async () => entry.click());
  const scenes = vi.mocked(createAtlasScene).mock.results.length;
  await act(async () => button("Chart settings").click());
  const clearance = container.querySelector<HTMLInputElement>(
    'input[aria-label="Island clearance"]'
  );
  assert(clearance);
  await act(async () => {
    Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      "value"
    )?.set?.call(clearance, "60");
    clearance.dispatchEvent(new Event("input", { bubbles: true }));
  });
  // The relayout settles after its pause and rebuilds the scene.
  await act(() => new Promise((done) => setTimeout(done, 400)));
  const { results } = vi.mocked(createAtlasScene).mock;
  expect(results.length).toBeGreaterThan(scenes);
  const rebuilt = await results.at(-1)?.value;
  expect(rebuilt?.setDomain).toHaveBeenLastCalledWith("shapes");
});

it("tells an island's proximity and path regions once the readings read after load arrive, keeping the scene", async () => {
  const data = await loadAtlas();
  const [territory] = data.territories;
  assert(territory);
  let arrive: (value: LateCodex) => void = () => undefined;
  const late = new Promise<LateCodex>((done) => {
    arrive = done;
  });
  vi.stubGlobal(
    "fetch",
    vi.fn(() => new Promise(() => undefined))
  );
  await act(async () => {
    root.render(createElement(Atlas, { data, late }));
  });
  const scenes = vi.mocked(createAtlasScene).mock.results.length;
  await act(async () => button("Find a place").click());
  const island = container.querySelector<HTMLButtonElement>(
    `.atlas-index button[value="${territory.id}"]`
  );
  assert(island);
  await act(async () => island.click());
  const place = () => container.querySelector(".atlas-place")?.textContent;
  expect(place()).not.toContain("proximity:");
  expect(place()).not.toContain("path region");
  await act(async () => {
    arrive({
      nesting: {
        folders: [],
        pathRegions: [
          { files: 1, id: "src", package: territory.id, primaryFiles: 1 },
        ],
        seams: [],
      },
      proximity: {
        apart: { coChanges: [], files: [] },
        close: [],
        labelled: [territory.id],
      },
    });
    await late;
  });
  expect(place()).toContain("1 path region");
  expect(place()).toContain("proximity: 0 close but unrelated");
  expect(vi.mocked(createAtlasScene).mock.results).toHaveLength(scenes);
  const scene = await vi.mocked(createAtlasScene).mock.results.at(-1)?.value;
  expect(scene?.setData).toHaveBeenLastCalledWith(
    expect.objectContaining({
      proximity: expect.objectContaining({ labelled: [territory.id] }),
    })
  );
  vi.unstubAllGlobals();
});
