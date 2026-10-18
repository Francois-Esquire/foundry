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
    "showConnections",
    "domain",
    "legendHeight",
    "responsibility",
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
  const [territory] = state.data.territories;
  const hovered = {
    ...state,
    hover: territory ? { territory } : null,
    selection: territory ? { territory } : null,
    trades: [],
  };
  expect(planApply(state, hovered)).toEqual([]);
});
