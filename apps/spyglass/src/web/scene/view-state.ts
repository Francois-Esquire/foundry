import type { SpyglassData, Territory } from "../data/types";
import type { BelongingLayer, BelongingRegion } from "../layout/belonging";
import type { DomainRef } from "../layout/domain-extent";
import type { MapLabel } from "../layout/labels";
import type { NaturalFeature } from "../layout/natural-feature-inspection";
import type { ResponsibilityOverlay } from "../layout/responsibility-focus";
import type { TradeRoute } from "../layout/trade-routes";
import type { ChartSettings } from "../settings/chart-settings";

/** The pointer's preview over the belonging layer: the region it rests on, the feature it points at, and how far the emphasis has come up. */
export interface BelongingHover {
  emphasis: number;
  feature?: NaturalFeature;
  hovered?: string;
}

/** Everything one repaint of the scene reads, held in one place and changed by the scene alone. */
export interface ViewState {
  /** The belonging layer as applied; the pointer's hover and the reveal lie over it (`drawnBelonging`). */
  belonging: BelongingLayer | null;
  belongingHover: BelongingHover | null;
  /** The reveal animation's progress while it runs; none once it has, or when motion is reduced. */
  belongingReveal: number | undefined;
  /** The declared domain the reader chose to draw; none at first. */
  domain: DomainRef | null;
  /** The spyglass being drawn: the readings with any territory relayout applied. */
  drawingData: SpyglassData;
  /** The labels the last repaint placed, which a hit test reads first. */
  labels: MapLabel[];
  layoutTerritory: Territory | null;
  legendHeight: number;
  matches: BelongingRegion | undefined;
  /**
   * The spyglass the ink reads: the one the scene was built from, until the
   * late readings arrive; the geometry never changes.
   */
  readings: SpyglassData;
  responsibility: ResponsibilityOverlay | null;
  selected: string | null;
  selectedFile: string | null;
  settings: ChartSettings;
  showConnections: boolean;
  trades: TradeRoute[];
  visibility: { composition: boolean; files: boolean };
}

export function createViewState(
  data: SpyglassData,
  settings: ChartSettings
): ViewState {
  return {
    belonging: null,
    belongingHover: null,
    belongingReveal: undefined,
    domain: null,
    drawingData: data,
    labels: [],
    layoutTerritory: null,
    legendHeight: 0,
    matches: undefined,
    readings: data,
    responsibility: null,
    selected: null,
    selectedFile: null,
    settings: { ...settings },
    showConnections: false,
    trades: [],
    visibility: { composition: false, files: false },
  };
}

/** The readings with one island's relayout in place of its laid-out self. */
export function resolveSetTerritoryLayout(
  territory: Territory | null,
  data: SpyglassData
): SpyglassData {
  if (territory) {
    return {
      ...data,
      territories: data.territories.map((item) =>
        item.id === territory.id ? territory : item
      ),
    };
  }
  return data;
}

/**
 * The belonging layer as drawn and hit: the applied layer with the reveal's
 * progress and the pointer's hover over it. The hover's feature stands in
 * for the applied focus only while the pointer points at one.
 */
export function drawnBelonging(
  state: Pick<ViewState, "belonging" | "belongingHover" | "belongingReveal">
): BelongingLayer | null {
  const { belonging, belongingHover, belongingReveal } = state;
  if (!belonging) {
    return null;
  }
  const revealed =
    belongingReveal === undefined
      ? belonging
      : { ...belonging, reveal: belongingReveal };
  if (!belongingHover) {
    return revealed;
  }
  return {
    ...revealed,
    emphasis: belongingHover.emphasis,
    featureFocus: belongingHover.feature ?? belonging.featureFocus,
    hovered: belongingHover.hovered,
  };
}
