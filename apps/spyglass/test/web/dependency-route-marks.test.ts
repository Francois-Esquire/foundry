import assert from "node:assert/strict";
import { expect, it } from "vitest";
import { inkStyle } from "../../src/web/ladder/ink-table";
import {
  type DependencyRouteOptions,
  dependencyRouteContext,
  dependencyRouteMarks,
} from "../../src/web/layout/dependency-route-marks";
import { markLayers } from "../../src/web/scene/marks/layers";
import type { MarkFrame } from "../../src/web/scene/marks/mark-layer";
import { createViewState } from "../../src/web/scene/view-state";
import { defaultChartSettings } from "../../src/web/settings/chart-settings";
import { chartTilt } from "../../src/web/view/chart-view";
import { chartFixture } from "../helpers/chart-fixture";

const options: DependencyRouteOptions = {
  selectedFile: null,
  selectedTerritory: null,
  view: { height: 300, pixelsPerUnit: 2.5, tilt: 0, width: 300, x: 0, y: 0 },
};

function crowded() {
  const data = chartFixture();
  const [territory] = data.territories;
  const base = territory?.files[0];
  assert(territory && base);
  const ids = [
    "a-source",
    "a-target",
    "hub",
    ...Array.from({ length: 40 }, (_, i) => `z-${String(i).padStart(2, "0")}`),
  ];
  return {
    ...data,
    fileEdges: [
      { source: "a-source", target: "a-target" },
      ...ids
        .filter((id) => id.startsWith("z-"))
        .map((source) => ({ source, target: "hub" })),
    ],
    territories: [
      {
        ...territory,
        files: ids.map((id, index) => ({
          ...base,
          id,
          x: index * 2 - 40,
          y: index % 2 ? 10 : -10,
        })),
      },
    ],
  };
}

it("keeps the world overview free of local file routes even when a file remains selected", () => {
  const data = chartFixture();
  const world = {
    ...options,
    selectedFile: "study/coordinates.ts",
    view: { ...options.view, pixelsPerUnit: 0.8 },
  };
  expect(dependencyRouteContext(data, world)).toEqual({
    available: 0,
    budget: 0,
    routes: [],
    scope: "overview",
  });
  expect(dependencyRouteMarks(data, world)).toEqual([]);
  expect(
    dependencyRouteContext(data, {
      ...options,
      view: { ...options.view, pixelsPerUnit: 1.49 },
    }).routes
  ).toHaveLength(0);
  expect(
    dependencyRouteContext(data, {
      ...options,
      view: { ...options.view, pixelsPerUnit: 1.5 },
    }).routes
  ).toHaveLength(3);
  expect(dependencyRouteContext(data, options).routes).toHaveLength(3);
});

it("restricts unselected routes to visible local territories and honors territory focus", () => {
  const data = chartFixture();
  const [original] = data.territories;
  assert(original);
  const distant = {
    ...original,
    files: original.files.map((file) => ({ ...file, id: `far/${file.id}` })),
    id: "distant",
    x: 1000,
  };
  const distantEdges = data.fileEdges.map((edge) => ({
    source: `far/${edge.source}`,
    target: `far/${edge.target}`,
  }));
  const expanded = {
    ...data,
    fileEdges: [
      ...data.fileEdges,
      ...distantEdges,
      { source: "study/harbor.ts", target: "far/study/coordinates.ts" },
    ],
    territories: [original, distant],
  };
  const visible = dependencyRouteContext(expanded, options);
  expect(visible.available).toBe(3);
  expect(
    visible.routes.every((route) => route.from.territory.id === original.id)
  ).toBe(true);
  const focused = dependencyRouteContext(expanded, {
    ...options,
    selectedTerritory: distant.id,
  });
  expect(focused.scope).toBe("territory");
  expect(focused.routes).toEqual([]);
  const panned = dependencyRouteContext(expanded, {
    ...options,
    view: { ...options.view, x: 1000 },
  });
  expect(panned.routes).toHaveLength(3);
  expect(
    panned.routes.every((route) => route.from.territory.id === distant.id)
  ).toBe(true);
  const selected = { ...options, selectedFile: "study/harbor.ts" };
  expect(dependencyRouteContext(expanded, selected).routes).toHaveLength(2);
  expect(
    dependencyRouteContext(expanded, {
      ...selected,
      view: { ...options.view, x: 1000 },
    }).routes
  ).toEqual([]);
});

it("ranks recorded connectivity before stable IDs, caps routes, and gives a selected file the entire budget", () => {
  const data = crowded();
  const local = dependencyRouteContext(data, options);
  expect(local.available).toBe(41);
  expect(local.budget).toBe(12);
  expect(local.routes).toHaveLength(12);
  expect(local.routes.map((route) => route.source)).toEqual(
    Array.from({ length: 12 }, (_, i) => `z-${String(i).padStart(2, "0")}`)
  );
  const close = dependencyRouteContext(data, {
    ...options,
    view: { ...options.view, pixelsPerUnit: 8 },
  });
  expect(close.budget).toBe(24);
  expect(close.routes).toHaveLength(24);
  const selected = dependencyRouteContext(data, {
    ...options,
    selectedFile: "a-source",
  });
  expect(selected.scope).toBe("file");
  expect(selected.available).toBe(1);
  expect(selected.routes.map((route) => route.source)).toEqual(["a-source"]);
  const reversed = {
    ...data,
    fileEdges: [...data.fileEdges].reverse(),
    territories: data.territories.map((territory) => ({
      ...territory,
      files: [...territory.files].reverse(),
    })),
  };
  expect(
    dependencyRouteContext(reversed, options).routes.map(
      ({ source, target }) => [source, target]
    )
  ).toEqual(local.routes.map(({ source, target }) => [source, target]));
});

it("ignores duplicate, missing, and self edges before counting the display budget", () => {
  const data = chartFixture();
  const [edge] = data.fileEdges;
  assert(edge);
  const invalid = {
    ...data,
    fileEdges: [
      ...data.fileEdges,
      edge,
      { source: edge.source, target: edge.source },
      { source: "missing", target: edge.target },
    ],
  };
  expect(dependencyRouteContext(invalid, options).available).toBe(3);
});

it.each([0, chartTilt])(
  "draws canonical endpoints with imported-target arrows and selected incoming/outgoing ink at tilt %s",
  (tilt) => {
    const data = chartFixture();
    const [territory] = data.territories;
    assert(territory);
    const moved = { ...data, territories: [{ ...territory, x: 100, y: 200 }] };
    const selection = {
      ...options,
      selectedFile: "study/harbor.ts",
      view: { ...options.view, tilt, x: 100, y: 200 },
    };
    const [shaft, arrow] = dependencyRouteMarks(moved, selection);
    assert(shaft && arrow);
    expect(shaft.points).toEqual([70, 178, 104, 203]);
    expect(shaft.on).toBe("chart");
    expect(arrow.on).toBe("chart");
    expect(shaft.colour).toBe(inkStyle("selection-imports").hue);
    expect(arrow.dash).toBeUndefined();
    const [leftX = 0, leftY = 0, tipX = 0, tipY = 0, rightX = 0, rightY = 0] =
      arrow.points;
    const forwardX = tipX - (leftX + rightX) / 2;
    const forwardY = tipY - (leftY + rightY) / 2;
    expect(forwardX * 34 + forwardY * 25).toBeGreaterThan(0);
    const incoming = dependencyRouteMarks(moved, {
      ...selection,
      selectedFile: "study/coordinates.ts",
    });
    expect(incoming).toHaveLength(6);
    expect(
      incoming.every(
        (mark) => mark.colour === inkStyle("selection-importers").hue
      )
    ).toBe(true);
  }
);

it("yields selected routes to visible explicit import tracing and restores them when that layer is hidden", () => {
  const state = createViewState(chartFixture(), {
    ...defaultChartSettings,
    composition: { hidden: [], solo: [] },
  });
  state.selectedFile = "study/coordinates.ts";
  const frame: MarkFrame = {
    chart: {
      boundaries: {
        clearance: [],
        coasts: [],
        depths: [],
        footprint: [],
        foundations: [],
        groups: [],
        outer: [],
        pockets: [],
      },
      ripples: [],
      sea: { height: 1000, width: 1000 },
      topography: [],
    },
    state,
    time: 0,
    view: options.view,
  };
  const layer = markLayers.find(
    (candidate) => candidate.id === "dependency-routes"
  );
  assert(layer);
  const original = layer.marks(frame);
  expect(original).toHaveLength(6);
  expect(layer.marks({ ...frame, view: { ...frame.view, x: 1 } })).toBe(
    original
  );
  state.showConnections = true;
  expect(layer.marks(frame)).toEqual([]);
  state.settings = {
    ...state.settings,
    composition: { hidden: ["connections"], solo: [] },
  };
  expect(layer.marks(frame)).toHaveLength(6);
  state.settings = {
    ...state.settings,
    composition: { hidden: [], solo: ["dependency-routes"] },
  };
  expect(layer.marks(frame)).toHaveLength(6);
  state.settings = { ...state.settings, composition: { hidden: [], solo: [] } };
  state.responsibility = {
    links: [],
    members: [],
    pathDisagreement: [],
    related: [],
    territoryId: "study",
    totalLinks: 0,
    unresolved: [],
  };
  expect(layer.marks(frame)).toHaveLength(6);
  state.responsibility = null;
  state.selectedFile = null;
  expect(layer.marks(frame)).toHaveLength(6);
});
