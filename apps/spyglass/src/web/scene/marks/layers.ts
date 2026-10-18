import { belongingMarks } from "../../layout/belonging-marks";
import {
  type BelongingViewOptions,
  belongingView,
  compositionInView,
  focusedFileInView,
} from "../../layout/belonging-view";
import { boundaryMarks } from "../../layout/boundary-marks";
import { coastMarks } from "../../layout/coast-marks";
import { compassMarks } from "../../layout/compass-marks";
import { connectionMarks } from "../../layout/connection-marks";
import { crossingMarks } from "../../layout/crossing-marks";
import {
  departureMarks,
  domainDepartureMarks,
} from "../../layout/departure-marks";
import { domainExtent } from "../../layout/domain-extent";
import { domainMarks } from "../../layout/domain-marks";
import { fileMarks } from "../../layout/file-marks";
import { focusMarks } from "../../layout/focus-marks";
import { folderMarks } from "../../layout/folders";
import { chartGridMarks } from "../../layout/grid-marks";
import { hoverMarks } from "../../layout/hover-marks";
import { proximityMarks } from "../../layout/proximity-marks";
import {
  responsibilityFollowsZoom,
  responsibilityMarks,
} from "../../layout/responsibility-marks";
import { seaRippleMarks } from "../../layout/ripple-marks";
import { selectionMarks } from "../../layout/selection-marks";
import { topographyMarks } from "../../layout/topography-marks";
import { drawnBelonging } from "../view-state";
import {
  keyedMarks,
  type MarkFrame,
  type MarkLayer,
  staticMarks,
} from "./mark-layer";

/** The belonging layer as this frame shows it: the applied layer under the hover and the reveal, resolved against the view. */
function belongingOptions({ state, view }: MarkFrame): BelongingViewOptions {
  return {
    belonging: drawnBelonging(state),
    fileId: state.selectedFile,
    matches: state.matches,
    responsibility: state.responsibility,
    selected: state.selected,
    territories: state.drawingData.territories,
    view,
  };
}

/**
 * The island whose cells the belonging layer may have rearranged, for the
 * layers that draw inside cells; a matched region leads on the island it is
 * on, so the view's belonging decides.
 */
function belongingTerritory(frame: MarkFrame) {
  return belongingView(belongingOptions(frame)).belonging?.territory ?? null;
}

/**
 * The overlay of the selected island's responsibility, as this frame shows
 * it: none unless the island it is about is the selected one.
 */
function selectedResponsibility(frame: MarkFrame) {
  const { responsibility } = belongingView(belongingOptions(frame));
  const territory =
    responsibility &&
    frame.state.drawingData.territories.find(
      (item) => item.id === responsibility.territoryId
    );
  return responsibility &&
    territory &&
    frame.state.selected === responsibility.territoryId
    ? { overlay: responsibility, territory }
    : null;
}

/**
 * The chart's mark layers, bottom to top: the whole of the chart's
 * z-order, since every string is an element over the canvas. The first
 * three are static: built once from the chart's fixed geometry, or from
 * the islands and the selection, and only their alphas follow the zoom.
 * Belonging is built again as the applied layer, the hover's emphasis, the
 * reveal or the overlay changes, and as the zoom changes while natural
 * features are shown, since their pens follow it; the folders and the
 * domain are built once per chart and rearranged island. The connections
 * follow the selected file; the files are built again as the islands, the
 * overlay's evidence or the selected group change, their sizes and alphas
 * following the zoom as uniforms; the responsibility overlay follows its
 * overlay object, which the UI's animations replace, and the zoom while it
 * lays anything in world units; proximity is built once per chart and
 * selected file, and the file focus per selection. Above those, in the
 * order the painters had: topography is built once per set of
 * contours, whether they are on, and whether a composition veils them;
 * crossings, departures and the selection once per spyglass and selection,
 * the domain's plugs per domain; the compass once per chart; the
 * boundaries per outline set and visibility; the hover per hovered island.
 */
export const markLayers: readonly MarkLayer[] = [
  {
    id: "chart-grid",
    marks: staticMarks((frame) => [frame.chart.sea] as const, chartGridMarks),
  },
  {
    id: "sea-ripples",
    marks: staticMarks(
      (frame) => [frame.chart.ripples] as const,
      seaRippleMarks
    ),
  },
  {
    id: "coast",
    marks: staticMarks(
      (frame) =>
        [frame.state.drawingData.territories, frame.state.selected] as const,
      coastMarks
    ),
  },
  {
    id: "belonging",
    marks: keyedMarks(
      (frame) => {
        const { state, view } = frame;
        const options = belongingOptions(frame);
        return [
          state.belonging,
          state.belongingHover,
          state.belongingReveal,
          state.matches,
          state.responsibility,
          state.selected,
          state.selectedFile,
          state.drawingData.territories,
          state.settings.streams,
          focusedFileInView(options),
          compositionInView(options),
          state.belonging?.features ? view.pixelsPerUnit : 0,
        ];
      },
      (frame) => {
        const { state, view } = frame;
        const resolved = belongingView(belongingOptions(frame));
        return belongingMarks({
          activeRegion: resolved.activeRegion,
          baselineRegionId: resolved.baselineRegionId,
          belonging: resolved.belonging,
          districtFloor: resolved.districtFloor,
          hasComposition: resolved.hasComposition,
          matches: state.matches,
          pixels: view.pixelsPerUnit,
          responsibility: resolved.responsibility,
          streams: state.settings.streams,
        });
      }
    ),
  },
  {
    id: "folders",
    marks: keyedMarks(
      (frame) => [frame.state.drawingData, belongingTerritory(frame)],
      (frame) => {
        const territory = belongingTerritory(frame);
        return folderMarks(frame.state.drawingData, territory && { territory });
      }
    ),
  },
  {
    id: "domain",
    marks: keyedMarks(
      (frame) => [
        frame.state.drawingData,
        frame.state.domain,
        belongingTerritory(frame),
      ],
      (frame) => {
        const { domain, drawingData } = frame.state;
        const territory = belongingTerritory(frame);
        return domainMarks(
          drawingData,
          domain ? domainExtent(drawingData, domain) : null,
          territory && { territory }
        );
      }
    ),
  },
  {
    id: "connections",
    marks: keyedMarks(
      ({ state }) => [
        state.drawingData,
        state.showConnections,
        state.selectedFile,
        state.responsibility,
      ],
      ({ state }) =>
        state.showConnections && !state.responsibility
          ? connectionMarks(state.drawingData, state.selectedFile)
          : []
    ),
  },
  {
    id: "files",
    marks: keyedMarks(
      (frame) => {
        const { state } = frame;
        const options = belongingOptions(frame);
        return [
          state.drawingData,
          state.belonging,
          state.belongingHover?.hovered,
          state.matches,
          state.responsibility,
          state.selected,
          state.selectedFile,
          focusedFileInView(options),
          compositionInView(options),
        ];
      },
      (frame) => {
        const resolved = belongingView(belongingOptions(frame));
        return fileMarks({
          activeRegion: resolved.activeRegion,
          belonging: resolved.belonging,
          evidenceFiles: resolved.evidenceFiles,
          hasComposition: resolved.hasComposition,
          territories: frame.state.drawingData.territories,
        });
      }
    ),
  },
  {
    id: "responsibility",
    marks: keyedMarks(
      (frame) => {
        // The view's overlay is derived (its composition goes when its file
        // leaves the view), so the keys are what it is derived from.
        const shown = selectedResponsibility(frame);
        return [
          frame.state.drawingData,
          frame.state.responsibility,
          frame.state.selected,
          compositionInView(belongingOptions(frame)),
          shown && responsibilityFollowsZoom(shown.overlay)
            ? frame.view.pixelsPerUnit
            : 0,
        ];
      },
      (frame) => {
        const shown = selectedResponsibility(frame);
        return shown
          ? responsibilityMarks({
              overlay: shown.overlay,
              pixels: frame.view.pixelsPerUnit,
              territory: shown.territory,
            })
          : [];
      }
    ),
  },
  {
    id: "proximity",
    marks: staticMarks(
      ({ state }) => [state.drawingData, state.selectedFile] as const,
      proximityMarks
    ),
  },
  {
    id: "file-focus",
    marks: staticMarks(
      ({ state }) =>
        [
          state.drawingData.territories,
          state.selected,
          state.selectedFile,
        ] as const,
      focusMarks
    ),
  },
  {
    id: "topography",
    marks: keyedMarks(
      (frame) => [
        frame.chart.topography,
        frame.state.settings.contours,
        belongingView(belongingOptions(frame)).hasComposition,
      ],
      (frame) =>
        frame.state.settings.contours
          ? topographyMarks(
              frame.chart.topography,
              belongingView(belongingOptions(frame)).hasComposition
            )
          : []
    ),
  },
  {
    id: "crossings",
    marks: staticMarks(
      ({ state }) => [state.drawingData, state.selected] as const,
      crossingMarks
    ),
  },
  {
    id: "departures",
    marks: staticMarks(
      ({ state }) => [state.drawingData, state.selected] as const,
      departureMarks
    ),
  },
  {
    id: "domain-departures",
    marks: keyedMarks(
      ({ state }) => [state.drawingData, state.domain],
      ({ state }) =>
        domainDepartureMarks(
          state.drawingData,
          state.domain ? domainExtent(state.drawingData, state.domain) : null
        )
    ),
  },
  {
    id: "selection",
    marks: staticMarks(
      ({ state }) => [state.drawingData, state.selected] as const,
      selectionMarks
    ),
  },
  {
    id: "compass",
    marks: staticMarks(
      ({ state }) => [state.drawingData] as const,
      compassMarks
    ),
  },
  {
    id: "boundaries",
    marks: staticMarks(
      (frame) =>
        [frame.chart.boundaries, frame.state.settings.boundaries] as const,
      boundaryMarks
    ),
  },
  {
    id: "hover",
    marks: staticMarks(({ state }) => [state.hovered] as const, hoverMarks),
  },
];
