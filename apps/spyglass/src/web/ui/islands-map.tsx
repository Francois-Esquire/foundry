import {
  type RefObject,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { SpyglassSelection } from "../interaction/selection";
import { filePlacesOf, loadIslandsChart } from "../islands-host/chart";
import {
  type Chart,
  type Described,
  type Islands,
  IslandsCanvas,
  type IslandsControls,
  type IslandsDebug,
  type IslandsError,
  type IslandsFrame,
  type IslandsStats,
  type IslandsView,
} from "../islands-host/islands-api";
import {
  compositionOf,
  islandsSettingsOf,
  pitchOf,
  renderStatusOf,
  selectedIdOf,
  selectionOf,
  zoomed,
} from "../islands-host/map-view";
import { pickIdentity } from "../islands-host/pick-identity";
import { markLoad, recordStage, releaseFirstFrame } from "../timings";
import type { MapHandle, SelectionRef } from "../view/map-contract";
import { ChartChrome } from "./chart-chrome";
import {
  type ChartChromeModel,
  createChromePresenter,
} from "./chart-chrome-model";
import { type LabelsReport, MapLabels } from "./map-labels/map-labels";
import type { SpyglassState } from "./spyglass-state";

/**
 * The Islands renderer as the viewer's map, mounted by `spyglass-view.tsx`,
 * with the `MapHandle` behind `mapRef`. It reaches Islands only through
 * `islands-host/islands-api.ts`.
 *
 * It loads the chart from the spyglass's one dataset and the map its
 * territories were laid out from, then composes the map: an
 * `<IslandsCanvas>` with the DOM labels (`MapLabels`) and the chart chrome
 * drawn over it, the labels placing themselves through the canvas's
 * `useIslands`. The reader's settings, the selection and the controls go
 * in as props; Islands' events come out as callbacks.
 *
 * Selection is the host's: a click in Islands tells it through `onSelect`,
 * and the snapshot's selection reaches Islands as `selected`, the camera
 * framing an island with `frame`. A ring has no selection in the viewer:
 * choosing one clears the host's, and `selected` is left out while Islands
 * keeps the ring chosen, until the host selects something, or Escape or the
 * overview lets it go. The camera is held north-up (`turn: false`), the labels and the
 * chrome reading the view unturned, and stands at the reader's elevation
 * from the moment Islands fits the chart.
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

/**
 * Names what a pick chose in the console, for now, until a panel shows it:
 * the package, the building and its files, the file, or the bank and its
 * shared dependencies, with how long after the click Islands named it.
 * Letting go logs nothing.
 */
function logPick(
  chosen: Described | null,
  chart: Chart,
  data: SpyglassState["data"],
  click: { at: number | null }
): void {
  if (!chosen) {
    return;
  }
  const afterClickMs =
    click.at === null ? null : Math.round(performance.now() - click.at);
  click.at = null;
  console.info("[spyglass] pick", {
    ...pickIdentity(chosen, chart, data),
    afterClickMs,
  });
}

const NO_WEBGPU =
  "The map could not open: this browser has no WebGPU. Reload in a browser with WebGPU enabled.";

const LOADING = "Unfolding the spyglass…";

const MAP_LABEL = "Codebase spyglass. Drag to pan, scroll to zoom.";

const reducedMotionQuery = "(prefers-reduced-motion: reduce)";

/** A developer session's timing of Islands' CPU steps, as performance measures. */
const measuredSteps: IslandsDebug = {
  time: (name, ms) => {
    const end = performance.now();
    performance.measure(`spyglass:islands:${name}`, { end, start: end - ms });
  },
};

/** What one open map was opened with: its chart, the camera it opened at, and where its chrome is presented. */
interface Opened {
  chart: Chart;
  present: ReturnType<typeof createChromePresenter>;
  view: IslandsView | undefined;
}

/** What one open map keeps between Islands' events. */
interface Session {
  /** The selection the map last showed; null while Islands holds a ring. */
  applied: SelectionRef | null;
  /** The chart Islands draws, once loaded. */
  chart: Chart | null;
  failure: string | null;
  /** Whether Islands has drawn its first frame. */
  framed: boolean;
  islands: Islands | null;
  /**
   * Whether Islands has placed its camera (fitted the chart, or opened at
   * the saved view) and the map has stood it at the reader's elevation.
   * Until then the snapshot's selection is left out.
   */
  settled: boolean;
  stats: IslandsStats | null;
}

const newSession = (): Session => ({
  applied: null,
  chart: null,
  failure: null,
  framed: false,
  islands: null,
  settled: false,
  stats: null,
});

/** The words a failure is shown in: a browser without WebGPU is told so; anything else, as it came. */
function failureText(failure: IslandsError): string {
  if (failure.kind === "unsupported") {
    return NO_WEBGPU;
  }
  const { error } = failure;
  return error instanceof Error ? error.message : String(error);
}

const sameSelection = (a: SelectionRef | null, b: SelectionRef | null) =>
  a?.territoryId === b?.territoryId && a?.fileId === b?.fileId;

/** Whether the page asks for reduced motion; false outside a browser. */
const prefersReducedMotion = () =>
  typeof window !== "undefined" &&
  window.matchMedia(reducedMotionQuery).matches;

export function IslandsMap(props: IslandsMapProps) {
  const { state, mapRef } = props;
  const { geometry, developer } = state;
  const section = useRef<HTMLElement>(null);
  const latest = useRef(props);
  const session = useRef<Session>(newSession());
  const labelsReport = useRef<LabelsReport | null>(null);
  /** When the last click let go, so the log can say how long Islands took to name what it fell on. */
  const click = useRef<{ at: number | null }>({ at: null });
  /** The camera as the last map left it, so a reopened map opens there. */
  const savedView = useRef<IslandsView | null>(null);
  const [opened, setOpened] = useState<Opened | null>(null);
  const [chrome, setChrome] = useState<ChartChromeModel | null>(null);
  const [status, setStatus] = useState(LOADING);
  const [settled, setSettled] = useState(false);
  /** Whether Islands holds a ring chosen, which the host's selection cannot name. */
  const [heldRing, setHeldRing] = useState(false);
  const [reducedMotion, setReducedMotion] = useState(prefersReducedMotion);

  useEffect(() => {
    latest.current = props;
  });

  const fail = useCallback((reported: IslandsError) => {
    const failure = failureText(reported);
    session.current.failure = failure;
    if (!session.current.framed) {
      // No frame will come; what waits for one goes ahead.
      releaseFirstFrame();
    }
    setStatus(failure);
  }, []);

  /**
   * Once Islands has placed its camera (its first stats come straight
   * after it fits the chart, before any frame is drawn): the reader's
   * elevation, then the snapshot's selection, which a file frames from
   * there.
   */
  const settle = useCallback(() => {
    const { current } = session;
    const { islands } = current;
    if (current.settled || !islands) {
      return;
    }
    current.settled = true;
    const { chartSettings, selection } = latest.current.state;
    islands.setView({
      ...islands.view,
      pitch: pitchOf(chartSettings.elevation),
    });
    current.applied = selection;
    setSettled(true);
  }, []);

  const ready = useCallback(
    (islands: Islands | null) => {
      session.current.islands = islands;
      if (!mapRef) {
        return;
      }
      mapRef.current = islands && {
        describe: () =>
          compositionOf(session.current.stats, {
            counts: labelsReport.current?.counts() ?? {},
            updateMs: labelsReport.current?.updateMs ?? null,
          }),
        focus: (selection) => {
          // The overview lets a held ring go too: the host's selection is
          // already null, so nothing else would clear it.
          if (selection === null) {
            setHeldRing(false);
          }
          islands.frame(selectedIdOf(selection));
        },
        getRenderStatus: () =>
          renderStatusOf(session.current.stats, session.current.failure),
        zoom: (factor) => islands.setView(zoomed(islands.view, factor)),
      };
    },
    [mapRef]
  );

  const drew = useCallback(
    ({ cpuMs }: IslandsFrame) => {
      // A closed map's last frame, before its listeners are gone, is not
      // the next map's.
      if (!session.current.islands) {
        return;
      }
      // The FPS readout counts these; each is the time Islands took to
      // encode and submit the frame.
      recordStage(developer, "render-submit", cpuMs);
      settle();
      const { current } = session;
      if (current.islands) {
        savedView.current = current.islands.view;
      }
      if (!current.framed) {
        current.framed = true;
        markLoad("spyglass:first-frame");
        setStatus("");
        latest.current.onReadyChange?.(true);
      }
    },
    [developer, settle]
  );

  const measured = useCallback(
    (stats: IslandsStats) => {
      if (!session.current.islands) {
        return;
      }
      session.current.stats = stats;
      settle();
      if (stats.buildMs !== null) {
        markLoad("spyglass:terrain-built");
      }
    },
    [settle]
  );

  const chose = useCallback((chosen: Described | null) => {
    const { data, selection } = latest.current.state;
    const { chart } = session.current;
    // Named once the viewer has taken the choice, so the log can never
    // hold it up.
    if (chart) {
      queueMicrotask(() => logPick(chosen, chart, data, click.current));
    }
    if (chosen?.kind === "ring") {
      // The viewer has no ring selection: the host's is cleared, and
      // Islands keeps the ring, `selected` left out while it does.
      setHeldRing(true);
      session.current.applied = null;
      if (selection) {
        latest.current.onSelect(null);
      }
      return;
    }
    setHeldRing(false);
    if (chosen?.kind === "building") {
      // A building is picked where the reader is looking: the viewer
      // takes its package (and its file, when it holds one alone)
      // without the camera moving, and Islands keeps the building.
      const picked = selectionOf(chosen, data);
      session.current.applied = picked && {
        territoryId: picked.territory.id,
        ...(picked.file && { fileId: picked.file.id }),
      };
      latest.current.onSelect(picked);
      return;
    }
    // The echo of the snapshot's own selection (a file selects its
    // island) is not the reader's choice.
    if ((chosen?.id ?? null) !== selectedIdOf(selection)) {
      latest.current.onSelect(selectionOf(chosen, data));
    }
  }, []);

  const hovered = useCallback(
    (described: Described | null) =>
      latest.current.onHover?.(
        selectionOf(described, latest.current.state.data)
      ),
    []
  );

  const activated = useCallback(
    (selection: SpyglassSelection) => latest.current.onSelect(selection),
    []
  );

  useEffect(() => {
    const query = window.matchMedia(reducedMotionQuery);
    const changed = () => setReducedMotion(query.matches);
    query.addEventListener("change", changed);
    return () => query.removeEventListener("change", changed);
  }, []);

  useEffect(() => {
    const element = section.current;
    const markClick = () => {
      click.current.at = performance.now();
    };
    element?.addEventListener("pointerup", markClick);
    return () => element?.removeEventListener("pointerup", markClick);
  }, []);

  // Only a new geometry (or a developer session) opens a new map; every
  // other change reaches the open one as the canvas's props.
  useEffect(() => {
    let disposed = false;
    const controller = new AbortController();
    session.current = newSession();
    setOpened(null);
    setChrome(null);
    setSettled(false);
    setHeldRing(false);
    setStatus(LOADING);
    latest.current.onReadyChange?.(false);
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
        places: filePlacesOf(geometry),
        signal: controller.signal,
        visualization: frame.visualization,
      });
      if (disposed) {
        return;
      }
      const present = createChromePresenter((model) => {
        if (!disposed) {
          setChrome(model);
        }
      });
      session.current.chart = chart;
      setOpened({ chart, present, view: savedView.current ?? undefined });
    };
    start().catch((error: unknown) => {
      // Closed while loading: the abort's rejection is not a failure, and
      // the next map waits for its own first frame.
      if (!disposed) {
        fail({ error, kind: "runtime" });
      }
    });
    return () => {
      disposed = true;
      controller.abort();
      latest.current.onReadyChange?.(false);
    };
  }, [geometry, developer, fail]);

  useEffect(() => {
    const handleEscape = (event: KeyboardEvent) => {
      if (
        event.key === "Escape" &&
        !event.defaultPrevented &&
        !document.querySelector("dialog[open]")
      ) {
        // A ring the host cannot clear: letting it go names the host's
        // (cleared) selection as `selected` again, and Islands lets go.
        setHeldRing(false);
        latest.current.onEscape();
      }
    };
    window.addEventListener("keydown", handleEscape);
    return () => window.removeEventListener("keydown", handleEscape);
  }, []);

  // The snapshot's selection: the camera goes to a new island (a file is
  // chosen as its module, which Islands frames on its own). A cleared
  // selection leaves the camera; the overview is `focus(null)`'s. The
  // host's change wins over a ring Islands holds; the host clearing its
  // selection for a ring (`applied` already null) leaves the ring.
  useEffect(() => {
    const { current } = session;
    const { islands } = current;
    if (
      !(settled && islands) ||
      sameSelection(current.applied, state.selection)
    ) {
      return;
    }
    current.applied = state.selection;
    setHeldRing(false);
    if (state.selection && state.selection.fileId === undefined) {
      islands.frame(state.selection.territoryId);
    }
  }, [settled, state.selection]);

  // The camera's elevation, whenever the reader changes it; the map stands
  // at it from the moment it settles, so the panel and the camera agree.
  const { elevation } = state.chartSettings;
  useEffect(() => {
    const { islands } = session.current;
    if (!(session.current.settled && islands)) {
      return;
    }
    islands.setView({ ...islands.view, pitch: pitchOf(elevation) });
  }, [elevation]);

  // The reader's settings Islands has a counterpart for, and whether the
  // camera flies or jumps. Escape and the camera's keys listen on the
  // canvas once it has focus, so they never take keys from the panels; the
  // window's Escape is the host's (above).
  const { waves } = state.chartSettings;
  const settings = useMemo(
    () => islandsSettingsOf({ waves }, reducedMotion),
    [waves, reducedMotion]
  );
  const controls = useMemo<IslandsControls>(
    () => ({ keyboard: "canvas", reducedMotion, turn: false }),
    [reducedMotion]
  );
  // Left out until the camera is placed, and while Islands holds a ring.
  const selected =
    settled && !(heldRing && state.selection === null)
      ? selectedIdOf(state.selection)
      : undefined;

  return (
    <section
      aria-label="Interactive spyglass"
      className="spyglass-map-view"
      ref={section}
    >
      {opened && (
        <IslandsCanvas
          chart={opened.chart}
          className="spyglass-map"
          controls={controls}
          debug={developer ? measuredSteps : undefined}
          label={MAP_LABEL}
          onError={fail}
          onFrame={drew}
          onHover={hovered}
          onReady={ready}
          onSelect={chose}
          onStats={measured}
          selected={selected}
          settings={settings}
          view={opened.view}
        >
          <MapLabels
            developer={developer}
            onActivate={activated}
            present={opened.present}
            report={labelsReport}
            state={state}
          />
          <ChartChrome model={chrome} />
        </IslandsCanvas>
      )}
      {status && (
        <p className="spyglass-status" role="status">
          {status}
        </p>
      )}
    </section>
  );
}
