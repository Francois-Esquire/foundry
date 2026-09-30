import type { BelongingLayer } from "../belonging";
import { type ChartSettings, defaultChartSettings } from "../chart-settings";
import { defaultLandmassSettings, type LandmassSettings } from "../landmasses";
import type { ResponsibilityOverlay } from "../responsibility-focus";
import type { AtlasSelection } from "../scene/scene";
import type { TradeRoute } from "../trade-routes";
import type { AtlasData, FormerPackage, Territory } from "../types";

/** Plain map data. React, the renderer, and shell UI have separate lifetimes. */
export interface AtlasState {
  atmosphereEnabled: boolean;
  belongingLayer: BelongingLayer | null;
  chartSettings: ChartSettings;
  data: AtlasData;
  hover: AtlasSelection | null;
  hoveredWreck: FormerPackage | null;
  layoutSettings: LandmassSettings;
  lens: "belonging" | "files";
  responsibility: ResponsibilityOverlay | null;
  selectedWreck: FormerPackage | null;
  selection: AtlasSelection | null;
  showConnections: boolean;
  territoryLayout: Territory | null;
  trades: TradeRoute[];
}

export function createAtlasState(data: AtlasData): AtlasState {
  return {
    atmosphereEnabled: false,
    belongingLayer: null,
    chartSettings: {
      ...defaultChartSettings,
      boundaries: { ...defaultChartSettings.boundaries },
      layers: { ...defaultChartSettings.layers },
    },
    data,
    hover: null,
    hoveredWreck: null,
    layoutSettings: { ...defaultLandmassSettings },
    lens: "belonging",
    responsibility: null,
    selectedWreck: null,
    selection: null,
    showConnections: false,
    territoryLayout: null,
    trades: [],
  };
}
