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
  configureComposition?: () => void;
  configurePresentation?: (progress: number) => void;
  configureRendering: (rendering: ChartSettings["rendering"]) => void;
  /** The weather's two toggles, which set the materials' uniforms. */
  configureWeather: (
    settings: Pick<ChartSettings, "clouds" | "waves" | "composition">
  ) => void;
  focus: SpyglassScene["focus"];
  render: () => void;
  setBelonging: (value: AppliedState["belongingLayer"]) => void;
  state: ViewState;
}): SpyglassScene["apply"] {
  const { state } = context;
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
  const changes: Record<
    Change,
    (next: AppliedState, plan: readonly Change[]) => void
  > = {
    belongingLayer: (next) => context.setBelonging(next.belongingLayer),
    chartSettings: (next) => {
      state.settings = { ...next.chartSettings };
      context.configurePresentation?.(state.settings.presentation);
      context.configureRendering(state.settings.rendering);
      context.configureWeather(state.settings);
      context.configureComposition?.();
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
    /** The selection reaches the scene here alone: the focus resolves its ids on the island as drawn and flies there. */
    selection: (next) => context.focus(next.selection),
    showConnections: (next) => {
      state.showConnections = next.showConnections;
    },
    /**
     * The relayout replaces the island in the drawing, and the camera
     * returns to what the snapshot selects on it, as relaid; unless the
     * selection's own step follows in this plan, which flies there once.
     */
    territoryLayout: (next, plan) => {
      state.layoutTerritory = next.territoryLayout;
      state.drawingData = resolveSetTerritoryLayout(
        next.territoryLayout,
        state.readings
      );
      refreshMatches();
      if (!plan.includes("selection")) {
        context.focus(next.selection);
      }
    },
  };
  let applied: AppliedState | null = null;
  return (next) => {
    const plan = planApply(applied, next);
    for (const change of plan) {
      changes[change](next, plan);
    }
    applied = next;
    if (plan.length) {
      context.render();
    }
  };
}
