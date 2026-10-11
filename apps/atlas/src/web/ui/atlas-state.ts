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
  belongingLayer: BelongingLayer | null;
  chartSettings: ChartSettings;
  data: AtlasData;
  /** A developer session (`?dev`, or the dev server): paint timings (renderer controls follow in 4.1). */
  developer: boolean;
  /**
   * The declared domain drawn across the islands, chosen in Find. Not a
   * selection: it stays while islands, districts and files are selected.
   */
  domain: string | null;
  /**
   * The atlas as laid out, without the readings that arrive after load: the
   * scene is built from it, and rebuilt only when it changes.
   */
  geometry: AtlasData;
  hover: AtlasSelection | null;
  hoveredWreck: FormerPackage | null;
  /** Why the import edges a trace asked for could not be read; null when they could, or have not been asked for. */
  importsFailure: string | null;
  /** Whether the import edges a trace asked for are being read. */
  importsReading: boolean;
  layoutSettings: LandmassSettings;
  /** The legend's height in CSS pixels, which the latitude scale stops short of. */
  legendHeight: number;
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
    belongingLayer: null,
    chartSettings: {
      ...defaultChartSettings,
      boundaries: { ...defaultChartSettings.boundaries },
      layers: { ...defaultChartSettings.layers },
      rendering: { ...defaultChartSettings.rendering },
    },
    data,
    developer,
    domain: null,
    geometry: data,
    hover: null,
    hoveredWreck: null,
    importsFailure: null,
    importsReading: false,
    layoutSettings: { ...defaultLandmassSettings },
    legendHeight: 0,
    mapLayer: "belonging",
    responsibility: null,
    selectedWreck: null,
    selection: null,
    showConnections: false,
    territoryLayout: null,
    trades: [],
  };
}
