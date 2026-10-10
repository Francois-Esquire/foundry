import type { BelongingLayer } from "../belonging";
import { type ChartSettings, defaultChartSettings } from "../chart-settings";
import { defaultLandmassSettings, type LandmassSettings } from "../landmasses";
import type { ResponsibilityOverlay } from "../responsibility-focus";
import type { AtlasSelection } from "../scene/scene";
import type { TradeRoute } from "../trade-routes";
import type { AtlasData, FormerPackage, Territory } from "../types";

/** What the map draws over the islands: belonging regions, or files alone. */
export type MapLayer = "belonging" | "files";

/** Plain map data. React, the renderer, and shell UI have separate lifetimes. */
export interface AtlasState {
  atmosphereEnabled: boolean;
  belongingLayer: BelongingLayer | null;
  chartSettings: ChartSettings;
  data: AtlasData;
  /** A developer session (`?dev`, or the dev server): paint timings (renderer controls follow in 4.1). */
  developer: boolean;
  hover: AtlasSelection | null;
  hoveredWreck: FormerPackage | null;
  layoutSettings: LandmassSettings;
  mapLayer: MapLayer;
  responsibility: ResponsibilityOverlay | null;
  selectedWreck: FormerPackage | null;
  selection: AtlasSelection | null;
  showConnections: boolean;
  territoryLayout: Territory | null;
  trades: TradeRoute[];
}

export function createAtlasState(
  data: AtlasData,
  developer = false
): AtlasState {
  return {
    atmosphereEnabled: false,
    belongingLayer: null,
    chartSettings: {
      ...defaultChartSettings,
      boundaries: { ...defaultChartSettings.boundaries },
      layers: { ...defaultChartSettings.layers },
      rendering: { ...defaultChartSettings.rendering },
    },
    data,
    developer,
    hover: null,
    hoveredWreck: null,
    layoutSettings: { ...defaultLandmassSettings },
    mapLayer: "belonging",
    responsibility: null,
    selectedWreck: null,
    selection: null,
    showConnections: false,
    territoryLayout: null,
    trades: [],
  };
}
