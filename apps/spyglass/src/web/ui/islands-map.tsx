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

interface IslandsMapProps {
  mapRef?: RefObject<MapHandle | null>;
  onEscape: () => void;
  onHover?: (selection: SpyglassSelection | null) => void;
  onReadyChange?: (ready: boolean) => void;
  onSelect: (selection: SpyglassSelection | null) => void;
  state: SpyglassState;
}

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

const measuredSteps: IslandsDebug = {
  time: (name, ms) => {
    const end = performance.now();
    performance.measure(`spyglass:islands:${name}`, { end, start: end - ms });
  },
};

interface Opened {
  chart: Chart;
  present: ReturnType<typeof createChromePresenter>;
  view: IslandsView | undefined;
}

interface Session {
  applied: SelectionRef | null;
  chart: Chart | null;
  failure: string | null;
  framed: boolean;
  islands: Islands | null;
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

function failureText(failure: IslandsError): string {
  if (failure.kind === "unsupported") {
    return NO_WEBGPU;
  }
  const { error } = failure;
  return error instanceof Error ? error.message : String(error);
}

const sameSelection = (a: SelectionRef | null, b: SelectionRef | null) =>
  a?.territoryId === b?.territoryId && a?.fileId === b?.fileId;

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
  const click = useRef<{ at: number | null }>({ at: null });
  const savedView = useRef<IslandsView | null>(null);
  const [opened, setOpened] = useState<Opened | null>(null);
  const [chrome, setChrome] = useState<ChartChromeModel | null>(null);
  const [status, setStatus] = useState(LOADING);
  const [settled, setSettled] = useState(false);
  const [heldRing, setHeldRing] = useState(false);
  const [reducedMotion, setReducedMotion] = useState(prefersReducedMotion);

  useEffect(() => {
    latest.current = props;
  });

  const fail = useCallback((reported: IslandsError) => {
    const failure = failureText(reported);
    session.current.failure = failure;
    if (!session.current.framed) {
      releaseFirstFrame();
    }
    setStatus(failure);
  }, []);

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
      if (!session.current.islands) {
        return;
      }
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
    if (chart) {
      queueMicrotask(() => logPick(chosen, chart, data, click.current));
    }
    if (chosen?.kind === "ring") {
      setHeldRing(true);
      session.current.applied = null;
      if (selection) {
        latest.current.onSelect(null);
      }
      return;
    }
    setHeldRing(false);
    if (chosen?.kind === "building") {
      const picked = selectionOf(chosen, data);
      session.current.applied = picked && {
        territoryId: picked.territory.id,
        ...(picked.file && { fileId: picked.file.id }),
      };
      latest.current.onSelect(picked);
      return;
    }
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
    const [frame] = geometry.frames;
    if (!frame) {
      return;
    }
    const start = async () => {
      await Promise.all([
        document.fonts.load("16px SpyglassDisplay"),
        document.fonts.load("12px SpyglassBody"),
      ]);
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
        setHeldRing(false);
        latest.current.onEscape();
      }
    };
    window.addEventListener("keydown", handleEscape);
    return () => window.removeEventListener("keydown", handleEscape);
  }, []);

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

  const { elevation } = state.chartSettings;
  useEffect(() => {
    const { islands } = session.current;
    if (!(session.current.settled && islands)) {
      return;
    }
    islands.setView({ ...islands.view, pitch: pitchOf(elevation) });
  }, [elevation]);

  const { waves } = state.chartSettings;
  const settings = useMemo(
    () => islandsSettingsOf({ waves }, reducedMotion),
    [waves, reducedMotion]
  );
  const controls = useMemo<IslandsControls>(
    () => ({ keyboard: "canvas", reducedMotion, turn: false }),
    [reducedMotion]
  );
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
