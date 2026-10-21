import { belongingMarks } from "../../layout/belonging-marks";
import { boundaryMarks } from "../../layout/boundary-marks";
import { coastMarks } from "../../layout/coast-marks";
import { connectionMarks } from "../../layout/connection-marks";
import { crossingMarks } from "../../layout/crossing-marks";
import {
  departureMarks,
  domainDepartureMarks,
} from "../../layout/departure-marks";
import {
  dependencyRouteContext,
  dependencyRouteMarks,
} from "../../layout/dependency-route-marks";
import { domainExtent } from "../../layout/domain-extent";
import { domainMarks } from "../../layout/domain-marks";
import { fileMarks, memberMarks } from "../../layout/file-marks";
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
import { isSceneLayerVisible } from "../../settings/scene-composition";
import {
  keyedMarks,
  type MarkFrame,
  type MarkLayer,
  staticMarks,
} from "./mark-layer";

/**
 * The island whose cells the belonging layer may have rearranged, for the
 * layers that draw inside cells; a matched region leads on the island it is
 * on, so the view's belonging decides.
 */
function belongingTerritory({ state }: MarkFrame) {
  return state.shown.belonging?.territory ?? null;
}

/**
 * The overlay of the selected island's responsibility, as this frame shows
 * it: none unless the island it is about is the selected one.
 */
function selectedResponsibility({ state }: MarkFrame) {
  const { responsibility } = state.shown;
  const territory =
    responsibility &&
    state.drawingData.territories.find(
      (item) => item.id === responsibility.territoryId
    );
  return responsibility &&
    territory &&
    state.selected === responsibility.territoryId
    ? { overlay: responsibility, territory }
    : null;
}

/** Explicit import tracing owns selected-file routes while its layer is visible. */
function tracingSelectedFile({ state }: MarkFrame): boolean {
  return Boolean(
    state.selectedFile &&
      state.showConnections &&
      state.responsibility === null &&
      isSceneLayerVisible(state.settings.composition, "connections")
  );
}

/**
 * The chart's mark layers, bottom to top: the whole of the chart's
 * z-order, since every string is an element over the canvas. The first
 * three are static: built once from the chart's fixed geometry, or from
 * the islands and the selection, and only their alphas follow the zoom.
 * The layers that read the belonging layer or the overlay read them as
 * the frame shows them, off `state.shown`, which the scene resolves once
 * a frame: belonging keys on that object, so it is built again as the
 * applied layer, the hover's emphasis, the reveal, the matched region, the
 * selection or the overlay changes, and as the zoom changes while natural
 * features are shown, since their pens follow it; every other layer keys
 * on the fields of it that it reads, which keep their identity through a
 * reveal and a hover, so those rebuild the belonging layer alone. The
 * folders and the domain are built once per chart and rearranged island.
 * The connections follow the selected file, and go while an overlay is
 * shown; the files are built again as the islands or the overlay's
 * evidence change, their sizes and alphas following the zoom as uniforms,
 * and the selected group's exact members over them as the group changes;
 * the responsibility overlay follows its overlay object as shown, which
 * the UI's animations replace, and the zoom while it lays anything in
 * world units; proximity is built once per chart and selected file, and
 * the file focus per selection. Above those, in the order the painters
 * had: topography is built once per set of contours, whether they are on,
 * and whether a composition veils them; crossings, departures and the
 * selection once per spyglass and selection, the domain's plugs per
 * domain; the boundaries per outline set and
 * visibility; the hover per hovered island.
 */
export const markLayers: readonly MarkLayer[] = [
  {
    id: "dependency-routes",
    marks: keyedMarks(
      (frame) => {
        if (tracingSelectedFile(frame)) {
          return [true];
        }
        const { state, view } = frame;
        return [
          ...dependencyRouteContext(state.drawingData, {
            selectedFile: state.selectedFile,
            selectedTerritory: state.selected,
            view,
          }).routes,
          state.selectedFile,
          view.pixelsPerUnit,
          view.tilt,
        ];
      },
      (frame) =>
        tracingSelectedFile(frame)
          ? []
          : dependencyRouteMarks(frame.state.drawingData, {
              selectedFile: frame.state.selectedFile,
              selectedTerritory: frame.state.selected,
              view: frame.view,
            })
    ),
  },
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
      ({ state, view }) => [
        state.shown,
        state.settings.streams,
        state.shown.belonging?.features ? view.pixelsPerUnit : 0,
      ],
      ({ state, view }) => {
        const { shown } = state;
        return belongingMarks({
          activeRegion: shown.activeRegion,
          baselineRegionId: shown.baselineRegionId,
          belonging: shown.belonging,
          districtFloor: shown.districtFloor,
          hasComposition: shown.hasComposition,
          matches: state.matches,
          pixels: view.pixelsPerUnit,
          responsibility: shown.responsibility,
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
        // Read for whether one is shown, so the layer keys on that alone.
        state.responsibility !== null,
      ],
      ({ state }) =>
        state.showConnections && state.responsibility === null
          ? connectionMarks(state.drawingData, state.selectedFile)
          : []
    ),
  },
  {
    id: "files",
    marks: keyedMarks(
      ({ state }) => [state.drawingData, state.shown.evidenceFiles],
      ({ state }) =>
        fileMarks({
          evidenceFiles: state.shown.evidenceFiles,
          territories: state.drawingData.territories,
        })
    ),
  },
  {
    id: "file-members",
    marks: keyedMarks(
      ({ state }) => {
        const { shown } = state;
        return [
          shown.belonging?.files,
          shown.belonging?.territory,
          shown.activeRegion,
          shown.hasComposition,
        ];
      },
      ({ state }) => {
        const { shown } = state;
        return memberMarks({
          activeRegion: shown.activeRegion,
          belonging: shown.belonging,
          hasComposition: shown.hasComposition,
        });
      }
    ),
  },
  {
    id: "responsibility",
    marks: keyedMarks(
      (frame) => {
        const shown = selectedResponsibility(frame);
        return [
          frame.state.drawingData,
          frame.state.shown.responsibility,
          frame.state.selected,
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
      ({ chart, state }) => [
        chart.topography,
        state.settings.contours,
        state.shown.hasComposition,
      ],
      ({ chart, state }) =>
        state.settings.contours
          ? topographyMarks(chart.topography, state.shown.hasComposition)
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
