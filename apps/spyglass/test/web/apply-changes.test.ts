import { expect, it, vi } from "vitest";
import { createApply } from "../../src/web/scene/apply-changes";
import { createViewState } from "../../src/web/scene/view-state";
import { defaultChartSettings } from "../../src/web/settings/chart-settings";
import { createSpyglassState } from "../../src/web/ui/spyglass-state";
import { loadSpyglass } from "../helpers/reference-spyglass";

/** The overlay about one island's first file, with nothing else to resolve. */
function overlayOn(territoryId: string, fileId: string) {
  return {
    links: [],
    members: [fileId],
    pathDisagreement: [],
    related: [],
    territoryId,
    totalLinks: 0,
    unresolved: [],
  };
}

it("finds the overlay's matched region again when the drawing changes under it", async () => {
  const data = await loadSpyglass();
  const territory = data.territories.find((item) => item.files.length > 0);
  const file = territory?.files[0];
  if (!(territory && file)) {
    throw new Error("The fixture has no island with files.");
  }
  const state = createViewState(data, defaultChartSettings);
  const apply = createApply({
    configureRendering: vi.fn(),
    configureWeather: vi.fn(),
    focus: vi.fn(),
    render: vi.fn(),
    setBelonging: vi.fn(),
    state,
  });
  const applied = {
    ...createSpyglassState(data),
    responsibility: overlayOn(territory.id, file.id),
  };
  apply(applied);
  expect(state.matches?.members.map((member) => member.id)).toEqual([file.id]);

  // Late readings move the file: the match now holds the file as drawn.
  const moved = {
    ...data,
    territories: data.territories.map((item) =>
      item.id === territory.id
        ? {
            ...item,
            files: item.files.map((candidate) =>
              candidate.id === file.id
                ? { ...candidate, x: candidate.x + 5 }
                : candidate
            ),
          }
        : item
    ),
  };
  apply({ ...applied, data: moved });
  expect(state.matches?.members[0]?.x).toBe(file.x + 5);

  // A relayout without the file leaves nothing to match.
  apply({
    ...applied,
    data: moved,
    territoryLayout: { ...territory, files: [] },
  });
  expect(state.matches).toBeUndefined();
});

it("hands the weather's toggles to the materials when the chart settings change", async () => {
  const data = await loadSpyglass();
  const state = createViewState(data, defaultChartSettings);
  const configureWeather = vi.fn();
  const render = vi.fn();
  const apply = createApply({
    configureRendering: vi.fn(),
    configureWeather,
    focus: vi.fn(),
    render,
    setBelonging: vi.fn(),
    state,
  });
  const applied = createSpyglassState(data);
  apply(applied);
  expect(configureWeather).toHaveBeenLastCalledWith(
    expect.objectContaining({ clouds: true, waves: true })
  );
  const toggled = {
    ...applied,
    chartSettings: { ...applied.chartSettings, waves: false },
  };
  apply(toggled);
  expect(configureWeather).toHaveBeenLastCalledWith(
    expect.objectContaining({ clouds: true, waves: false })
  );
  expect(state.settings.waves).toBe(false);
  expect(render).toHaveBeenCalledTimes(2);
  // A snapshot that changed elsewhere leaves the weather alone.
  apply({ ...toggled, legendHeight: 40 });
  expect(configureWeather).toHaveBeenCalledTimes(2);
});

it("focuses what the snapshot selects, and again on the island as relaid", async () => {
  const data = await loadSpyglass();
  const territory = data.territories.find((item) => item.files.length > 0);
  const file = territory?.files[0];
  if (!(territory && file)) {
    throw new Error("The fixture has no island with files.");
  }
  const state = createViewState(data, defaultChartSettings);
  const focus = vi.fn();
  const apply = createApply({
    configureRendering: vi.fn(),
    configureWeather: vi.fn(),
    focus,
    render: vi.fn(),
    setBelonging: vi.fn(),
    state,
  });
  const applied = createSpyglassState(data);
  // The first apply focuses nothing, once: the overview.
  apply(applied);
  expect(focus).toHaveBeenCalledTimes(1);
  expect(focus).toHaveBeenLastCalledWith(null);
  const selection = { fileId: file.id, territoryId: territory.id };
  apply({ ...applied, selection });
  expect(focus).toHaveBeenCalledTimes(2);
  expect(focus).toHaveBeenLastCalledWith(selection);
  // A relayout alone refocuses the selection it has, by id, once the island
  // as relaid is in the drawing, so the focus resolves it there.
  const relaid = { ...territory, x: territory.x + 40 };
  focus.mockImplementation(() => {
    expect(state.drawingData.territories).toContain(relaid);
  });
  apply({ ...applied, selection, territoryLayout: relaid });
  expect(focus).toHaveBeenCalledTimes(3);
  expect(focus).toHaveBeenLastCalledWith(selection);
  focus.mockImplementation(() => undefined);
  // A relayout with a new selection flies once, to the new selection.
  const island = { territoryId: territory.id };
  apply({ ...applied, selection: island, territoryLayout: territory });
  expect(focus).toHaveBeenCalledTimes(4);
  expect(focus).toHaveBeenLastCalledWith(island);
  // Clearing the selection focuses nothing again.
  apply({ ...applied, selection: null, territoryLayout: territory });
  expect(focus).toHaveBeenCalledTimes(5);
  expect(focus).toHaveBeenLastCalledWith(null);
});

it("hands the camera's angle to the camera when the chart settings change, and not otherwise", async () => {
  const data = await loadSpyglass();
  const state = createViewState(data, defaultChartSettings);
  const configureCamera = vi.fn();
  const apply = createApply({
    configureCamera,
    configureRendering: vi.fn(),
    configureWeather: vi.fn(),
    focus: vi.fn(),
    render: vi.fn(),
    setBelonging: vi.fn(),
    state,
  });
  const applied = createSpyglassState(data);
  apply(applied);
  expect(configureCamera).toHaveBeenLastCalledWith(defaultChartSettings.camera);
  apply({ ...applied, showConnections: true });
  expect(configureCamera).toHaveBeenCalledTimes(1);
  apply({
    ...applied,
    chartSettings: { ...applied.chartSettings, camera: { elevation: 90 } },
  });
  expect(configureCamera).toHaveBeenLastCalledWith({ elevation: 90 });
});
