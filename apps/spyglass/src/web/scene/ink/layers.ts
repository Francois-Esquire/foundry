import { paintBoundaries } from "../boundaries";
import { paintHoverInk } from "../hover-ink";
import { paintGridReferences } from "../paint-paper";
import { paintSelectionInk } from "../selection-ink";
import { paintTopography } from "../topography";
import { paintChartCompass } from "./compass";
import { paintConnections } from "./connections";
import { paintCrossings } from "./crossings";
import { paintDepartures } from "./departures";
import { paintDomainDepartures } from "./domain";
import { paintFocusedFile } from "./file-focus";
import { paintFiles } from "./files";
import { paintMapLabels } from "./labels";
import { paintLatitudeScale } from "./latitude-scale";
import { paintProximity } from "./proximity";
import { paintResponsibilityOverlay } from "./responsibility";
import { paintSeaCaption } from "./sea-caption";
import type { InkState } from "./state";

/** One ink layer: what it is called when timed, and how it paints from the repaint's state. */
export interface InkLayer {
  id: string;
  paint: (state: InkState) => void;
}

/**
 * The ink canvas's layers, bottom to top: this order is the map's z-order
 * above the mark layers (`scene/marks/layers.ts`), which hold its foot: the
 * grid, the ripples, the coast, the belonging pigment with its natural
 * features, the folder cuts and the domain's band and marks draw as GPU
 * marks under all of these. `paintInk` saves and restores the context
 * around each, so a layer starts from the scene's drawing state and never
 * inherits another's.
 */
export const inkLayers = [
  { id: "connections", paint: paintConnections },
  { id: "files", paint: paintFiles },
  { id: "responsibility", paint: paintResponsibilityOverlay },
  { id: "proximity", paint: paintProximity },
  { id: "file-focus", paint: paintFocusedFile },
  { id: "labels", paint: paintMapLabels },
  {
    id: "topography",
    paint: ({ ctx, detail, labels, topography, view }) => {
      if (!view) {
        return;
      }
      ctx.save();
      ctx.globalAlpha = 1 - detail.composition * 0.8;
      paintTopography(ctx, topography, view, labels);
      ctx.restore();
    },
  },
  { id: "crossings", paint: paintCrossings },
  { id: "departures", paint: paintDepartures },
  { id: "domain-departures", paint: paintDomainDepartures },
  {
    id: "selection",
    paint: ({ ctx, data, labels, selected, view }) =>
      view &&
      paintSelectionInk(ctx, data, selected, view.pixelsPerUnit, labels),
  },
  {
    id: "grid-references",
    paint: ({ data, labelContext, labels, view }) =>
      view && paintGridReferences(labelContext, view, data, labels),
  },
  { id: "latitude-scale", paint: paintLatitudeScale },
  { id: "compass", paint: paintChartCompass },
  { id: "sea-caption", paint: paintSeaCaption },
  {
    id: "boundaries",
    paint: ({ boundaries, ctx, pixels }) =>
      boundaries &&
      paintBoundaries(ctx, boundaries.layers, boundaries.visible, pixels),
  },
  {
    id: "hover",
    paint: ({ ctx, hovered, labels, pixels }) =>
      hovered && paintHoverInk(ctx, hovered(labels), pixels),
  },
] as const satisfies readonly InkLayer[];
