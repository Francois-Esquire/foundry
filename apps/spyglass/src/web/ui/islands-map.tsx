import { type RefObject, useEffect, useRef, useState } from "react";
import type { SpyglassSelection } from "../interaction/selection";
import { loadIslandsChart } from "../islands-host/chart";
import {
  createIslands,
  type Islands,
  type IslandsError,
  type IslandsStats,
} from "../islands-host/islands-api";
import {
  compositionOf,
  inkViewOf,
  islandsSettingsOf,
  pitchOf,
  projectionOf,
  renderStatusOf,
  selectedIdOf,
  selectionOf,
  zoomed,
} from "../islands-host/map-view";
import type { AppliedState } from "../layout/applied-state";
import type { LabelLayer } from "../layout/label-layer";
import { createViewState, type ViewState } from "../layout/view-state";
import { isSceneLayerVisible } from "../settings/scene-composition";
import {
  markLoad,
  recordStage,
  releaseFirstFrame,
  timeStage,
} from "../timings";
import type { MapHandle, SelectionRef } from "../view/map-contract";
import { ChartChrome } from "./chart-chrome";
import {
  type ChartChromeModel,
  createChromePresenter,
} from "./chart-chrome-model";
import { createLabelsLayer } from "./map-labels/labels-layer";
import type { SpyglassState } from "./spyglass-state";

/**
 * The Islands renderer as the viewer's map, mounted by `spyglass-view.tsx`,
 * with the `MapHandle` behind `mapRef`. It reaches Islands only through
 * `islands-host/islands-api.ts`.
 *
 * It loads the chart from the spyglass's one dataset and the map its
 * territories were laid out from, opens Islands on a canvas, and keeps the
 * DOM labels and the chart chrome over it, placed with Islands' `project`
 * on the land's height (`heightAt`) and redrawn on every frame Islands
 * draws and on every state change (a still chart draws no frames).
 * Selection is the host's: a click in Islands tells it through `onSelect`,
 * and the snapshot's selection reaches Islands through `select`, the camera
 * framing it with `frame`. A ring has no selection in the viewer: choosing
 * one clears the host's, and Islands keeps the ring chosen until the host
 * selects something or Escape lets go. The camera is held north-up
 * (`turn: false`), the labels and the chrome reading the view unturned, and
 * stands at the reader's elevation from the moment Islands fits the chart.
 */

interface IslandsMapProps {
  /** Commands used by the surrounding UI, filled once the map is up. */
  mapRef?: RefObject<MapHandle | null>;
  /** Escape was pressed with no dialog open: the host clears its selection. */
  onEscape: () => void;
  onHover?: (selection: SpyglassSelection | null) => void;
  onReadyChange?: (ready: boolean) => void;
  /** A click or a label's activation named a place, or nothing: the host writes its selection. */
  onSelect: (selection: SpyglassSelection | null) => void;
  state: SpyglassState;
}

const NO_WEBGPU =
  "The map could not open: this browser has no WebGPU. Reload in a browser with WebGPU enabled.";

/** What one open map holds, between the effect that opens it and the ones that update it. */
interface OpenMap {
  /** Whether Islands holds a ring chosen, which the host's selection cannot name. */
  heldRing: boolean;
  islands: Islands;
  labels: LabelLayer;
  /** Main-thread milliseconds of the labels' last update. */
  labelsMs: number | null;
  /** Lays the labels and the chrome over the frame as the camera stands. */
  repaint: () => void;
  /**
   * Whether Islands has placed its camera (fitted the chart, or opened at
   * the saved view) and the map has stood it at the reader's elevation and
   * shown the snapshot's selection. Until then the effects below leave
   * Islands alone; settling reads the latest of both.
   */
  settled: boolean;
  stats: IslandsStats | null;
  viewState: ViewState;
}

const reducedMotionQuery = "(prefers-reduced-motion: reduce)";

/** The words a failure is shown in: a browser without WebGPU is told so; anything else, as it came. */
function failureText(failure: IslandsError): string {
  if (failure.kind === "unsupported") {
    return NO_WEBGPU;
  }
  const { error } = failure;
  return error instanceof Error ? error.message : String(error);
}

/** The labels' state from the snapshot: what they name and where. */
function syncViewState(target: ViewState, state: AppliedState): void {
  target.drawingData = state.data;
  target.legendHeight = state.legendHeight;
  target.readings = state.data;
  target.selected = state.selection?.territoryId ?? null;
  target.selectedFile = state.selection?.fileId ?? null;
  target.settings = state.chartSettings;
  target.showConnections = state.showConnections;
}

const sameSelection = (a: SelectionRef | null, b: SelectionRef | null) =>
  a?.territoryId === b?.territoryId && a?.fileId === b?.fileId;

/**
 * Shows the viewer's selection in Islands: chosen, and, when `framed`, the
 * camera over it. A file is chosen as its module, which Islands frames on
 * its own; an island is framed here.
 */
function showSelection(
  islands: Islands,
  selection: SelectionRef | null,
  framed: boolean
): void {
  islands.select(selectedIdOf(selection));
  if (framed && selection && selection.fileId === undefined) {
    islands.frame(selection.territoryId);
  }
}

export function IslandsMap(props: IslandsMapProps) {
  const { state, mapRef } = props;
  const { geometry, developer } = state;
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const labelsHost = useRef<HTMLDivElement>(null);
  const open = useRef<OpenMap | null>(null);
  const latest = useRef(props);
  /** The camera as the last map left it, so a reopened map opens there. */
  const savedView = useRef<Islands["view"] | null>(null);
  const [chrome, setChrome] = useState<ChartChromeModel | null>(null);
  const [status, setStatus] = useState("Unfolding the spyglass…");
  /** The selection the open map last showed; null while Islands holds a ring. */
  const applied = useRef<SelectionRef | null>(null);
  const [reducedMotion, setReducedMotion] = useState(
    () =>
      typeof window !== "undefined" &&
      window.matchMedia(reducedMotionQuery).matches
  );
  /** The reduced-motion setting as it stands, for a map that opens after it changed. */
  const latestReducedMotion = useRef(reducedMotion);

  useEffect(() => {
    latest.current = props;
    latestReducedMotion.current = reducedMotion;
  });

  useEffect(() => {
    const query = window.matchMedia(reducedMotionQuery);
    const changed = () => setReducedMotion(query.matches);
    query.addEventListener("change", changed);
    return () => query.removeEventListener("change", changed);
  }, []);

  // Only a new geometry (or a developer session) opens a new map; every
  // other change reaches the open one through the effects below, the
  // reduced-motion setting included.
  useEffect(() => {
    let disposed = false;
    let framed = false;
    let failure: string | null = null;
    const controller = new AbortController();
    const unsubscribe: (() => void)[] = [];
    setChrome(null);
    setStatus("Unfolding the spyglass…");
    latest.current.onReadyChange?.(false);
    const present = createChromePresenter((model) => {
      if (!disposed) {
        setChrome(model);
      }
    });
    const fail = (reported: IslandsError) => {
      failure = failureText(reported);
      if (!framed) {
        // No frame will come; what waits for one goes ahead.
        releaseFirstFrame();
      }
      if (!disposed) {
        setStatus(failure);
      }
    };
    // A spyglass is one workspace's, laid out as one frame (`loadSpyglass`).
    const [frame] = geometry.frames;
    if (!frame) {
      return;
    }
    const start = async () => {
      await Promise.all([
        document.fonts.load("16px SpyglassDisplay"),
        document.fonts.load("12px SpyglassBody"),
      ]);
      // The map the territories were laid out from, so the chart and the
      // labels share coordinates.
      const { chart } = await loadIslandsChart({
        dataset: frame.dataset,
        signal: controller.signal,
        visualization: frame.visualization,
      });
      const canvas = canvasRef.current;
      const labelRoot = labelsHost.current;
      if (disposed || !canvas || !labelRoot) {
        return;
      }
      const current = latest.current.state;
      const stillMotion = latestReducedMotion.current;
      const islands = createIslands(canvas, {
        chart,
        ...(developer && {
          debug: {
            time: (name: string, ms: number) => {
              const end = performance.now();
              performance.measure(`spyglass:islands:${name}`, {
                end,
                start: end - ms,
              });
            },
          },
        }),
        controls: {
          // Escape and the camera's keys listen on the canvas once it has
          // focus, so they never take keys from the panels; the window's
          // Escape is the host's (below).
          keyboard: "canvas",
          reducedMotion: stillMotion,
          turn: false,
        },
        settings: islandsSettingsOf(current.chartSettings, stillMotion),
        view: savedView.current ?? undefined,
      });
      const viewState = createViewState(current.data, current.chartSettings);
      const labels = createLabelsLayer({
        host: labelRoot,
        // Islands draws at the device's ratio, held between 1 and 2.
        pixelRatio: () => Math.min(2, Math.max(1, window.devicePixelRatio)),
        present,
        project: () =>
          projectionOf(islands, () => ({
            height: canvas.clientHeight,
            width: canvas.clientWidth,
          })),
        publish: (placed) => {
          viewState.labels = placed;
        },
      });
      const map: OpenMap = {
        heldRing: false,
        islands,
        labels,
        labelsMs: null,
        repaint: () => {
          const size = {
            height: canvas.clientHeight,
            width: canvas.clientWidth,
          };
          if (size.width === 0 || size.height === 0) {
            return;
          }
          const view = inkViewOf(islands, size);
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
          map.labelsMs = performance.now() - began;
        },
        settled: false,
        stats: null,
        viewState,
      };
      // Once Islands has placed its camera (its first stats come straight
      // after it fits the chart, before any frame is drawn): the reader's
      // elevation, then the snapshot's selection, which a file frames from
      // there.
      const settle = () => {
        if (map.settled) {
          return;
        }
        map.settled = true;
        const { chartSettings, selection } = latest.current.state;
        islands.setView({
          ...islands.view,
          pitch: pitchOf(chartSettings.camera.elevation),
        });
        showSelection(islands, selection, false);
        applied.current = selection;
        map.heldRing = false;
      };
      labels.setActivation((place) =>
        latest.current.onSelect({
          ...(place.file && { file: place.file }),
          territory: place.territory,
        })
      );
      unsubscribe.push(
        islands.on("frame", ({ cpuMs }) => {
          // The FPS readout counts these; each is the time Islands took to
          // encode and submit the frame.
          recordStage(developer, "render-submit", cpuMs);
          settle();
          map.repaint();
          if (!framed) {
            framed = true;
            markLoad("spyglass:first-frame");
            setStatus("");
            latest.current.onReadyChange?.(true);
          }
        }),
        islands.on("select", (chosen) => {
          const { data, selection } = latest.current.state;
          if (chosen?.kind === "ring") {
            // The viewer has no ring selection: the host's is cleared, and
            // Islands keeps the ring, which the selection effect, seeing
            // none applied, leaves chosen.
            map.heldRing = true;
            applied.current = null;
            if (selection) {
              latest.current.onSelect(null);
            }
            return;
          }
          map.heldRing = false;
          // The echo of the snapshot's own selection (a file selects its
          // island) is not the reader's choice.
          if ((chosen?.id ?? null) !== selectedIdOf(selection)) {
            latest.current.onSelect(selectionOf(chosen, data));
          }
        }),
        islands.on("hover", (hovered) =>
          latest.current.onHover?.(
            selectionOf(hovered, latest.current.state.data)
          )
        ),
        islands.on("stats", (stats) => {
          map.stats = stats;
          settle();
          if (stats.buildMs !== null) {
            markLoad("spyglass:terrain-built");
          }
        }),
        islands.on("error", fail)
      );
      canvas.setAttribute(
        "aria-label",
        "Codebase spyglass. Drag to pan, scroll to zoom."
      );
      open.current = map;
      if (mapRef) {
        mapRef.current = {
          describe: () =>
            compositionOf(map.stats, {
              counts: labels.stats(),
              updateMs: map.labelsMs,
            }),
          focus: (selection) => islands.frame(selectedIdOf(selection)),
          getRenderStatus: () => renderStatusOf(map.stats, failure),
          zoom: (factor) => islands.setView(zoomed(islands.view, factor)),
        };
      }
    };
    start().catch((error: unknown) => {
      // Closed while loading: the abort's rejection is not a failure, and
      // the next map waits for its own first frame.
      if (!disposed) {
        fail({ error, kind: "runtime" });
      }
    });
    const handleEscape = (event: KeyboardEvent) => {
      if (
        event.key === "Escape" &&
        !event.defaultPrevented &&
        !document.querySelector("dialog[open]")
      ) {
        const map: OpenMap | null = open.current;
        if (map?.heldRing) {
          // The host has no ring to clear; Islands lets it go.
          map.heldRing = false;
          map.islands.select(null);
        }
        latest.current.onEscape();
      }
    };
    window.addEventListener("keydown", handleEscape);
    return () => {
      disposed = true;
      controller.abort();
      latest.current.onReadyChange?.(false);
      for (const stop of unsubscribe) {
        stop();
      }
      const map: OpenMap | null = open.current;
      if (map) {
        savedView.current = map.islands.view;
        map.labels.dispose();
        map.islands.dispose();
      }
      open.current = null;
      if (mapRef) {
        mapRef.current = null;
      }
      window.removeEventListener("keydown", handleEscape);
    };
  }, [geometry, developer, mapRef]);

  // The snapshot's selection: Islands shows it chosen, and the camera goes
  // to a new one. A cleared selection leaves the camera; the overview is
  // `focus(null)`'s. The host's change wins over a ring Islands holds; the
  // host clearing its selection for a ring (`applied` already null) leaves
  // the ring.
  useEffect(() => {
    const map: OpenMap | null = open.current;
    if (!map?.settled || sameSelection(applied.current, state.selection)) {
      return;
    }
    applied.current = state.selection;
    map.heldRing = false;
    showSelection(map.islands, state.selection, true);
  }, [state.selection]);

  // The reader's settings Islands has a counterpart for, and whether the
  // camera flies or jumps.
  const { waves } = state.chartSettings;
  useEffect(() => {
    const islands = open.current?.islands;
    islands?.setSettings(islandsSettingsOf({ waves }, reducedMotion));
    islands?.setControls({ reducedMotion });
  }, [waves, reducedMotion]);

  // The camera's elevation, whenever the reader changes it; the map stands
  // at it from the moment it settles, so the panel and the camera agree.
  const { elevation } = state.chartSettings.camera;
  useEffect(() => {
    const map: OpenMap | null = open.current;
    if (!map?.settled) {
      return;
    }
    map.islands.setView({ ...map.islands.view, pitch: pitchOf(elevation) });
  }, [elevation]);

  // Everything else the labels read: a still chart draws no frame to
  // repaint them on.
  useEffect(() => {
    open.current?.repaint();
  }, [state]);

  return (
    <section aria-label="Interactive spyglass" className="spyglass-map-view">
      <div className="spyglass-map">
        <canvas ref={canvasRef} />
      </div>
      <div className="spyglass-map-labels" ref={labelsHost} />
      <ChartChrome model={chrome} />
      {status && (
        <p className="spyglass-status" role="status">
          {status}
        </p>
      )}
    </section>
  );
}
