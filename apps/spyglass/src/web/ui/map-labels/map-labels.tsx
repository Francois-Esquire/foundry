import { type RefObject, useEffect, useRef } from "react";
import type { SpyglassSelection } from "../../interaction/selection";
import { useIslands, useIslandsFrame } from "../../islands-host/islands-api";
import { inkViewOf, projectionOf } from "../../islands-host/map-view";
import type { AppliedState } from "../../layout/applied-state";
import { createViewState, type ViewState } from "../../layout/view-state";
import { isSceneLayerVisible } from "../../settings/scene-composition";
import { timeStage } from "../../timings";
import { createLabelsLayer, type LabelsLayerOptions } from "./labels-layer";

/** What the map's handle reports of the labels: what they hold, and how long their last update took. */
export interface LabelsReport {
  counts: () => Record<string, number>;
  /** Main-thread milliseconds of the labels' last update; null before the first. */
  updateMs: number | null;
}

interface MapLabelsProps {
  /** A developer session: each update is timed as the `layer:labels` stage. */
  developer: boolean;
  /** A label's activation (Enter or Space on it) named a place: the host writes its selection. */
  onActivate: (selection: SpyglassSelection) => void;
  /** Where the chart's chrome is presented from each update (`createChromePresenter`). */
  present: NonNullable<LabelsLayerOptions["present"]>;
  /** Filled while the labels are up, for the map's `describe`. */
  report?: RefObject<LabelsReport | null>;
  /** What the labels name and where. */
  state: AppliedState;
}

function syncViewState(target: ViewState, state: AppliedState): void {
  target.drawingData = state.data;
  target.legendHeight = state.legendHeight;
  target.readings = state.data;
  target.selected = state.selection?.territoryId ?? null;
  target.selectedFile = state.selection?.fileId ?? null;
  target.settings = state.chartSettings;
  target.showConnections = state.showConnections;
}

/** Islands draws at the device's ratio, held between 1 and 2. */
const pixelRatio = () => Math.min(2, Math.max(1, window.devicePixelRatio));

/**
 * The DOM labels over an `<IslandsCanvas>`, and the chrome presented from
 * them: placed with Islands' `project` on the land's height (`heightAt`,
 * through `projectionOf`) and redrawn on every frame Islands draws and on
 * every change of the snapshot, since a still chart draws no frames. The
 * layer itself is `createLabelsLayer`'s; this mounts it over the canvas
 * while Islands runs.
 */
export function MapLabels(props: MapLabelsProps) {
  const { developer, report, state } = props;
  const overlay = useIslands();
  const hostRef = useRef<HTMLDivElement>(null);
  const repaintRef = useRef<(() => void) | null>(null);
  const latest = useRef(props);

  useEffect(() => {
    latest.current = props;
  });

  useEffect(() => {
    const host = hostRef.current;
    if (!(overlay && host)) {
      return;
    }
    const { canvas, islands } = overlay;
    const size = () => ({
      height: canvas.clientHeight,
      width: canvas.clientWidth,
    });
    const initial = latest.current.state;
    const viewState = createViewState(initial.data, initial.chartSettings);
    const labels = createLabelsLayer({
      fileAt: (id) => islands.moduleAt(id),
      host,
      pixelRatio,
      present: (frame, metrics) => latest.current.present(frame, metrics),
      project: () => projectionOf(islands, size),
      publish: (placed) => {
        viewState.labels = placed;
      },
    });
    labels.setActivation((place) =>
      latest.current.onActivate({
        ...(place.file && { file: place.file }),
        territory: place.territory,
      })
    );
    const measured: LabelsReport = {
      counts: () => labels.stats(),
      updateMs: null,
    };
    if (report) {
      report.current = measured;
    }
    repaintRef.current = () => {
      const current = size();
      if (current.width === 0 || current.height === 0) {
        return;
      }
      const view = inkViewOf(islands, current);
      syncViewState(viewState, latest.current.state);
      labels.setVisible(
        isSceneLayerVisible(viewState.settings.composition, "labels")
      );
      const began = performance.now();
      timeStage(developer, "layer:labels", () => {
        const time = began / 1000;
        labels.updateAnnotations(view, viewState, time);
        labels.update(view, viewState, time);
      });
      measured.updateMs = performance.now() - began;
    };
    return () => {
      repaintRef.current = null;
      if (report) {
        report.current = null;
      }
      labels.dispose();
    };
  }, [overlay, developer, report]);

  useIslandsFrame(() => repaintRef.current?.());

  // Everything else the labels read: a still chart draws no frame to
  // repaint them on.
  useEffect(() => {
    repaintRef.current?.();
  }, [state]);

  return <div className="spyglass-map-labels" ref={hostRef} />;
}
