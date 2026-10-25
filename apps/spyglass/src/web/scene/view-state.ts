import type { SpyglassData, Territory } from "../data/types";
import type { BelongingLayer, BelongingRegion } from "../layout/belonging";
import { type BelongingView, belongingView } from "../layout/belonging-view";
import type { DomainRef } from "../layout/domain-extent";
import type { MapLabel } from "../layout/labels";
import type { NaturalFeature } from "../layout/natural-feature-inspection";
import type { ResponsibilityOverlay } from "../layout/responsibility-focus";
import type { ChartSettings } from "../settings/chart-settings";
import type { InkView } from "../view/chart-view";

/** The pointer's preview over the belonging layer: the region it rests on, the feature it points at, and how far the emphasis has come up. */
export interface BelongingHover {
  emphasis: number;
  feature?: NaturalFeature;
  hovered?: string;
}

/** Everything one repaint of the scene reads, held in one place and changed by the scene alone. */
export interface ViewState {
  /** The belonging layer as applied; the pointer's hover and the reveal lie over it (`drawnBelonging`), and `shown` resolves that against the view. */
  belonging: BelongingLayer | null;
  belongingHover: BelongingHover | null;
  /** The reveal animation's progress while it runs; none once it has, or when motion is reduced. */
  belongingReveal: number | undefined;
  /** The declared domain the reader chose to draw; none at first. */
  domain: DomainRef | null;
  /** The spyglass being drawn: the readings with any territory relayout applied. */
  drawingData: SpyglassData;
  /**
   * The island under the pointer, resolved each frame once the labels are
   * placed, since a label is hit before the land beneath it; the hover layer
   * inks its coast.
   */
  hovered: Territory | null;
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
  /**
   * The belonging layer and the overlay as this frame shows them: the
   * drawn layer, the matched region, the selection and the overlay
   * resolved against the view (`belonging-view.ts`). The scene writes it
   * once a frame, before any layer updates, so the mark layers, the labels
   * and the hit test read one answer; between frames it stands as the last
   * frame left it.
   */
  shown: BelongingView;
  visibility: { composition: boolean; files: boolean };
}

export function createViewState(
  data: SpyglassData,
  settings: ChartSettings
): ViewState {
  const state: Omit<ViewState, "shown"> = {
    belonging: null,
    belongingHover: null,
    belongingReveal: undefined,
    domain: null,
    drawingData: data,
    hovered: null,
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
    visibility: { composition: false, files: false },
  };
  return { ...state, shown: resolveShown(state, undefined) };
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

/** What the layer was last drawn from, and the drawing: handed back while the three are the same. */
let lastDrawn:
  | {
      belonging: BelongingLayer;
      drawn: BelongingLayer;
      hover: BelongingHover | null;
      reveal: number | undefined;
    }
  | undefined;

/**
 * The belonging layer as drawn and hit: the applied layer with the reveal's
 * progress and the pointer's hover over it. The hover's feature stands in
 * for the applied focus only while the pointer points at one. The drawing
 * is kept while the three are the same objects, so a pan under a hover
 * that has settled resolves to the same object frame after frame; a frame
 * of the reveal or of the emphasis makes a new one.
 */
export function drawnBelonging(
  state: Pick<ViewState, "belonging" | "belongingHover" | "belongingReveal">
): BelongingLayer | null {
  const { belonging, belongingHover, belongingReveal } = state;
  if (!belonging) {
    return null;
  }
  if (
    lastDrawn &&
    lastDrawn.belonging === belonging &&
    lastDrawn.hover === belongingHover &&
    lastDrawn.reveal === belongingReveal
  ) {
    return lastDrawn.drawn;
  }
  const revealed =
    belongingReveal === undefined
      ? belonging
      : { ...belonging, reveal: belongingReveal };
  const drawn = belongingHover
    ? {
        ...revealed,
        emphasis: belongingHover.emphasis,
        featureFocus: belongingHover.feature ?? belonging.featureFocus,
        hovered: belongingHover.hovered,
      }
    : revealed;
  lastDrawn = {
    belonging,
    drawn,
    hover: belongingHover,
    reveal: belongingReveal,
  };
  return drawn;
}

/**
 * The belonging layer and the overlay as the state shows them in the view:
 * the drawn layer and the rest of the state resolved through
 * `belongingView`, which keeps its answer while nothing changed. The scene
 * writes the result to `state.shown` each frame; a test that drives a
 * layer by hand does the same.
 */
export function resolveShown(
  state: Pick<
    ViewState,
    | "belonging"
    | "belongingHover"
    | "belongingReveal"
    | "drawingData"
    | "matches"
    | "responsibility"
    | "selected"
    | "selectedFile"
  >,
  view: InkView | undefined
): BelongingView {
  return belongingView({
    belonging: drawnBelonging(state),
    fileId: state.selectedFile,
    matches: state.matches,
    responsibility: state.responsibility,
    selected: state.selected,
    territories: state.drawingData.territories,
    view,
  });
}
