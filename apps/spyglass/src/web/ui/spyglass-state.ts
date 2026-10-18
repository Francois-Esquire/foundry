import type { FormerPackage, SpyglassData, Territory } from "../data/types";
import type { BelongingLayer } from "../layout/belonging";
import type { DomainRef } from "../layout/domain-extent";
import type { ResponsibilityOverlay } from "../layout/responsibility-focus";
import type { TradeRoute } from "../layout/trade-routes";
import type { SpyglassSelection } from "../scene/scene";
import {
  type ChartSettings,
  defaultChartSettings,
} from "../settings/chart-settings";
import {
  defaultLandmassSettings,
  type LandmassSettings,
} from "../settings/landmass-settings";

/** What the map draws over the islands: belonging regions, or files alone. */
export type MapLayer = "belonging" | "files";

/** Plain map data. React, the renderer, and shell UI have separate lifetimes. */
export interface SpyglassState {
  belongingLayer: BelongingLayer | null;
  chartSettings: ChartSettings;
  data: SpyglassData;
  /** A developer session (`?dev`, or the dev server): paint timings (renderer controls follow in 4.1). */
  developer: boolean;
  /**
   * The declared domain drawn across the islands, chosen in Find. Not a
   * selection: it stays while islands, districts and files are selected.
   */
  domain: DomainRef | null;
  /**
   * The spyglass as laid out, without the readings that arrive after load: the
   * scene is built from it, and rebuilt only when it changes.
   */
  geometry: SpyglassData;
  hover: SpyglassSelection | null;
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
  selection: SpyglassSelection | null;
  showConnections: boolean;
  territoryLayout: Territory | null;
  trades: TradeRoute[];
}

export function createSpyglassState(
  data: SpyglassData,
  developer = false
): SpyglassState {
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
