import { type RefObject, useEffect, useRef, useState } from "react";
import { chartFilters } from "../chart-settings";
import type { PlaybackSnapshot } from "../scene/playback";
import { type AtlasSelection, createAtlasScene } from "../scene/scene";
import type { TradeRoute } from "../trade-routes";
import type { FormerPackage, Territory } from "../types";
import type { AtlasState } from "./atlas-state";

/** Commands used by the surrounding UI; scene ownership stays in AtlasMap. */
export type AtlasMapHandle = Pick<
  Awaited<ReturnType<typeof createAtlasScene>>,
  | "focus"
  | "focusWreck"
  | "pinRegion"
  | "zoom"
  | "getPlayback"
  | "setTrackPlaying"
  | "setPlaybackSpeed"
  | "seek"
  | "play"
>;

interface AtlasMapProps {
  mapRef?: RefObject<AtlasMapHandle | null>;
  onEscape?: () => void;
  onHover?: (selection: AtlasSelection | null) => void;
  onSelect?: (selection: AtlasSelection | null) => void;
  onSettings?: () => void;
  onTrades?: (trades: TradeRoute[]) => void;
  onViewTerritory?: (territory: Territory | null) => void;
  onWreck?: (wreck: FormerPackage | null, selected: boolean) => void;
  state: AtlasState;
}

/** Presentation state and any saved camera or playback reach a fresh scene. */
function applyState(
  current: Awaited<ReturnType<typeof createAtlasScene>>,
  next: AtlasState,
  view: { x: number; y: number; pixels: number } | null,
  playback: PlaybackSnapshot | null
) {
  current.configure(next.chartSettings);
  current.setAtmosphere(next.atmosphereEnabled);
  current.setBelonging(next.belongingLayer);
  current.setTerritoryLayout(next.territoryLayout);
  current.setConnections(next.showConnections);
  current.setResponsibility(next.responsibility);
  if (view) {
    current.restoreView(view);
  }
  if (playback) {
    current.restorePlayback(playback);
  }
}

export function AtlasMap(props: AtlasMapProps) {
  const { state, mapRef } = props;
  const { data, layoutSettings, chartSettings } = state;
  const { layers } = chartSettings;
  const host = useRef<HTMLDivElement>(null);
  const scene = useRef<Awaited<ReturnType<typeof createAtlasScene>> | null>(
    null
  );
  const latest = useRef(props);
  const view = useRef<{ x: number; y: number; pixels: number } | null>(null);
  const playback = useRef<PlaybackSnapshot | null>(null);
  const [status, setStatus] = useState("Unfolding the atlas…");

  useEffect(() => {
    latest.current = props;
  });

  // Only geometry changes replace the scene. Event handlers and presentation
  // settings reach the existing scene without restarting its animation loops.
  useEffect(() => {
    let disposed = false;
    const onSettings = latest.current.onSettings
      ? () => latest.current.onSettings?.()
      : undefined;
    const selectWreck = (wreck: FormerPackage | null, selected: boolean) => {
      if (latest.current.onWreck) {
        latest.current.onWreck(wreck, selected);
      } else if (selected && wreck) {
        scene.current?.focusWreck(wreck);
      }
    };
    const open = async () => {
      try {
        await Promise.all([
          document.fonts.load("16px AtlasDisplay"),
          document.fonts.load("12px AtlasBody"),
        ]);
        if (disposed || !host.current) {
          return;
        }
        const current = await createAtlasScene(
          host.current,
          data,
          (value) => {
            if (latest.current.onSelect) {
              latest.current.onSelect(value);
            } else {
              scene.current?.focus(value?.territory ?? null, value?.file);
            }
          },
          (value) => latest.current.onHover?.(value),
          onSettings,
          (value) => latest.current.onTrades?.(value),
          layoutSettings.coastalBuffer,
          layers,
          selectWreck,
          (territory) => latest.current.onViewTerritory?.(territory)
        );
        if (disposed) {
          current.dispose();
          return;
        }
        scene.current = current;
        if (mapRef) {
          mapRef.current = current;
        }
        applyState(
          current,
          latest.current.state,
          view.current,
          playback.current
        );
        setStatus("");
      } catch {
        if (!disposed) {
          setStatus(
            "The map could not open. Reload in a browser with WebGL enabled."
          );
        }
      }
    };
    open();
    const handleEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !event.defaultPrevented) {
        if (latest.current.onEscape) {
          latest.current.onEscape();
        } else {
          scene.current?.focus(null);
        }
      }
    };
    window.addEventListener("keydown", handleEscape);
    return () => {
      disposed = true;
      view.current = scene.current?.captureView() ?? null;
      playback.current = scene.current?.getPlayback() ?? null;
      scene.current?.dispose();
      scene.current = null;
      if (mapRef) {
        mapRef.current = null;
      }
      window.removeEventListener("keydown", handleEscape);
    };
  }, [data, layoutSettings.coastalBuffer, layers, mapRef]);

  useEffect(() => {
    scene.current?.configure(chartSettings);
  }, [chartSettings]);
  useEffect(() => {
    scene.current?.setAtmosphere(state.atmosphereEnabled);
  }, [state.atmosphereEnabled]);
  useEffect(() => {
    scene.current?.setBelonging(state.belongingLayer);
  }, [state.belongingLayer]);
  useEffect(() => {
    scene.current?.setTerritoryLayout(state.territoryLayout);
  }, [state.territoryLayout]);
  useEffect(() => {
    scene.current?.setConnections(state.showConnections);
    scene.current?.setResponsibility(state.responsibility);
  }, [state.showConnections, state.responsibility]);

  return (
    <section aria-label="Interactive atlas" className="atlas-map-view">
      <div
        className="atlas-map"
        ref={host}
        style={{ filter: chartFilters[chartSettings.filter].filter }}
      />
      {status && (
        <p className="atlas-status" role="status">
          {status}
        </p>
      )}
    </section>
  );
}
