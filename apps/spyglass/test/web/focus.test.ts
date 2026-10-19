import { expect, it, vi } from "vitest";
import { createFocus } from "../../src/web/scene/focus";
import { createViewState } from "../../src/web/scene/view-state";
import { defaultChartSettings } from "../../src/web/settings/chart-settings";
import { frameFiles } from "../../src/web/view/chart-view";
import { loadSpyglass } from "../helpers/reference-spyglass";

/** The focus over a camera and a trade chart that record what they were asked. */
async function build() {
  const data = await loadSpyglass();
  const territory = data.territories.find((item) => item.files.length > 1);
  const file = territory?.files[0];
  if (!(territory && file)) {
    throw new Error("The fixture has no island with files.");
  }
  const state = createViewState(data, defaultChartSettings);
  const camera = { flyTo: vi.fn(), focus: vi.fn() };
  const trades = vi.fn((selected?: string | null) =>
    selected ? [{ selected }] : []
  );
  const trade = { seaTrades: (routes: unknown[]) => routes, trades };
  const tradeLayer = { setRoutes: vi.fn() };
  const onTrades = vi.fn();
  const { focus } = createFocus({
    camera,
    onTrades,
    state,
    trade: trade as unknown as Parameters<typeof createFocus>[0]["trade"],
    tradeLayer,
  });
  return { camera, file, focus, onTrades, state, territory, tradeLayer };
}

it("selects by id on the island as drawn, and flies to the file or the island's files", async () => {
  const { camera, file, focus, onTrades, state, territory, tradeLayer } =
    await build();
  // Built with the chart's trades, nothing selected.
  expect(tradeLayer.setRoutes).toHaveBeenLastCalledWith([]);
  focus({ fileId: file.id, territoryId: territory.id });
  expect(state.selected).toBe(territory.id);
  expect(state.selectedFile).toBe(file.id);
  expect(onTrades).toHaveBeenLastCalledWith([{ selected: territory.id }]);
  const [fileFrame] = camera.focus.mock.lastCall ?? [];
  expect(fileFrame).toMatchObject({ file, territory });
  expect(fileFrame.target.x).toBeCloseTo(territory.x + file.x);
  expect(fileFrame.target.y).toBeCloseTo(-territory.y - file.y);
  // An island alone is framed on its files' bounds, not its origin.
  focus({ territoryId: territory.id });
  expect(state.selectedFile).toBeNull();
  const [islandFrame] = camera.focus.mock.lastCall ?? [];
  const bounds = frameFiles(territory.files);
  expect(islandFrame).toMatchObject({ file: undefined, territory });
  expect(islandFrame.target.x).toBeCloseTo(territory.x + (bounds?.x ?? 0));
  // A relaid island is the one found: the file is focused where it now lies.
  const relaid = { ...territory, x: territory.x + 40 };
  state.drawingData = {
    ...state.drawingData,
    territories: state.drawingData.territories.map((item) =>
      item.id === territory.id ? relaid : item
    ),
  };
  focus({ fileId: file.id, territoryId: territory.id });
  const [relaidFrame] = camera.focus.mock.lastCall ?? [];
  expect(relaidFrame.territory).toBe(relaid);
  expect(relaidFrame.target.x).toBeCloseTo(relaid.x + file.x);
  // Nothing: the overview, with the chart's trades back.
  focus(null);
  expect(state.selected).toBeNull();
  expect(state.selectedFile).toBeNull();
  expect(onTrades).toHaveBeenLastCalledWith([]);
  expect(camera.focus.mock.lastCall?.[0]).toMatchObject({
    file: undefined,
    territory: null,
  });
  expect(camera.flyTo).not.toHaveBeenCalled();
});

it("treats an id the drawing does not hold as nothing selected", async () => {
  const { camera, focus, state } = await build();
  focus({ fileId: "nowhere", territoryId: "nowhere" });
  expect(state.selected).toBeNull();
  expect(state.selectedFile).toBeNull();
  expect(camera.focus.mock.lastCall?.[0]).toMatchObject({ territory: null });
});
