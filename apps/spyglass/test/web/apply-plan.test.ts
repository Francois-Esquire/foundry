import { expect, it } from "vitest";
import { planApply } from "../../src/web/scene/apply-plan";
import { createSpyglassState } from "../../src/web/ui/spyglass-state";
import { loadSpyglass } from "../helpers/reference-spyglass";

it("plans every field on the first apply, in the order the scene does the work", async () => {
  const state = createSpyglassState(await loadSpyglass());
  expect(planApply(null, state)).toEqual([
    "chartSettings",
    "data",
    "belongingLayer",
    "territoryLayout",
    "selection",
    "showConnections",
    "domain",
    "legendHeight",
    "responsibility",
  ]);
});

it("plans the selection after a relayout, so its flight is the one that lands", async () => {
  const state = createSpyglassState(await loadSpyglass());
  const [territory] = state.data.territories;
  const selected = {
    ...state,
    selection: territory ? { territoryId: territory.id } : null,
    territoryLayout: territory ?? null,
  };
  expect(planApply(state, selected)).toEqual(["territoryLayout", "selection"]);
  // The same selection again, as one object, plans nothing; a new object does.
  expect(planApply(selected, { ...selected })).toEqual([]);
  expect(
    planApply(selected, {
      ...selected,
      selection: territory ? { territoryId: territory.id } : null,
    })
  ).toEqual(["selection"]);
  expect(planApply(selected, { ...selected, selection: null })).toEqual([
    "selection",
  ]);
});

it("plans only the fields whose value changed, by identity", async () => {
  const state = createSpyglassState(await loadSpyglass());
  const [territory] = state.data.territories;
  const next = {
    ...state,
    chartSettings: { ...state.chartSettings },
    showConnections: true,
    territoryLayout: territory ?? null,
  };
  expect(planApply(state, next)).toEqual([
    "chartSettings",
    "territoryLayout",
    "showConnections",
  ]);
  expect(planApply(next, next)).toEqual([]);
});

it("plans no work for a snapshot that changed only outside what the scene draws", async () => {
  const state = createSpyglassState(await loadSpyglass());
  const [wreck] = state.data.formerPackages ?? [];
  const shell = {
    ...state,
    hoveredWreck: wreck ?? null,
    importsReading: true,
    mapLayer: "files" as const,
  };
  expect(planApply(state, shell)).toEqual([]);
});
