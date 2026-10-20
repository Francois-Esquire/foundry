import type { SpyglassData } from "../data/types";
import { matchedRegion } from "../layout/belonging";
import type { ChartSettings } from "../settings/chart-settings";
import { type AppliedState, type Change, planApply } from "./apply-plan";
import type { SpyglassScene } from "./handle";
import { resolveSetTerritoryLayout, type ViewState } from "./view-state";

/**
 * The scene's `apply`: plans which fields of the snapshot changed and does
 * each field's work in the plan's order, then asks for one frame.
 */
export function createApply(context: {
  configureRendering: (rendering: ChartSettings["rendering"]) => void;
  /** The weather's two toggles, which set the materials' uniforms. */
  configureWeather: (settings: Pick<ChartSettings, "clouds" | "waves">) => void;
  /** The geometry the scene was built from, whose islands a relayout refocuses. */
  data: SpyglassData;
  focus: SpyglassScene["focus"];
  render: () => void;
  setBelonging: (value: AppliedState["belongingLayer"]) => void;
  state: ViewState;
}): SpyglassScene["apply"] {
  const { data, state } = context;
  /** The region the overlay matches, found on the island as it is drawn now: again whenever the overlay or the drawing changes. */
  const refreshMatches = () => {
    const territory = state.drawingData.territories.find(
      (item) => item.id === state.responsibility?.territoryId
    );
    state.matches =
      state.responsibility && territory
        ? matchedRegion(territory, state.responsibility)
        : undefined;
  };
  const changes: Record<Change, (next: AppliedState) => void> = {
    belongingLayer: (next) => context.setBelonging(next.belongingLayer),
    chartSettings: (next) => {
      state.settings = { ...next.chartSettings };
      context.configureRendering(state.settings.rendering);
      context.configureWeather(state.settings);
    },
    data: (next) => {
      state.readings = next.data;
      state.drawingData = resolveSetTerritoryLayout(
        state.layoutTerritory,
        state.readings
      );
      refreshMatches();
    },
    domain: (next) => {
      state.domain = next.domain;
    },
    legendHeight: (next) => {
      state.legendHeight = next.legendHeight;
    },
    responsibility: (next) => {
      state.responsibility = next.responsibility;
      refreshMatches();
    },
    showConnections: (next) => {
      state.showConnections = next.showConnections;
    },
    /** The relayout replaces the island in the drawing, and the camera returns to what was selected on it. */
    territoryLayout: (next) => {
      state.layoutTerritory = next.territoryLayout;
      state.drawingData = resolveSetTerritoryLayout(
        next.territoryLayout,
        state.readings
      );
      refreshMatches();
      const current =
        data.territories.find((item) => item.id === state.selected) ?? null;
      context.focus(
        current,
        current?.files.find((item) => item.id === state.selectedFile)
      );
    },
  };
  let applied: AppliedState | null = null;
  return (next) => {
    const plan = planApply(applied, next);
    for (const change of plan) {
      changes[change](next);
    }
    applied = next;
    if (plan.length) {
      context.render();
    }
  };
}
