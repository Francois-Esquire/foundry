import { type RefObject, useEffect, useRef, useState } from "react";
import type { FormerPackage, Territory } from "../data/types";
import type { TradeRoute } from "../layout/trade-routes";
import { createSpyglassScene, type SpyglassSelection } from "../scene/scene";
import { releaseFirstFrame } from "../timings";
import type { SpyglassState } from "./spyglass-state";

/** Commands used by the surrounding UI; scene ownership stays in SpyglassMap. */
export type SpyglassMapHandle = Pick<
  Awaited<ReturnType<typeof createSpyglassScene>>,
  "focus" | "focusWreck" | "getRenderStatus" | "pinRegion" | "zoom"
>;

interface SpyglassMapProps {
  mapRef?: RefObject<SpyglassMapHandle | null>;
  onEscape?: () => void;
  onHover?: (selection: SpyglassSelection | null) => void;
  onSelect?: (selection: SpyglassSelection | null) => void;
  onSettings?: () => void;
  onTrades?: (trades: TradeRoute[]) => void;
  onViewTerritory?: (territory: Territory | null) => void;
  onWreck?: (wreck: FormerPackage | null, selected: boolean) => void;
  state: SpyglassState;
}

/** Presentation state and any saved camera reach a fresh scene. */
function applyState(
  current: Awaited<ReturnType<typeof createSpyglassScene>>,
  next: SpyglassState,
  view: { x: number; y: number; pixels: number } | null
) {
  current.configure(next.chartSettings);
  current.setData(next.data);
  current.setBelonging(next.belongingLayer);
  current.setTerritoryLayout(next.territoryLayout);
  current.setConnections(next.showConnections);
  current.setDomain(next.domain);
  current.setLegendHeight(next.legendHeight);
  current.setResponsibility(next.responsibility);
  if (view) {
    current.restoreView(view);
  }
}

export function SpyglassMap(props: SpyglassMapProps) {
  const { state, mapRef } = props;
  const { geometry, developer, layoutSettings, chartSettings } = state;
  // Primitives, so a new settings object with the same layers (Reset, or any
  // reader setting) reaches the scene through configure, not a rebuild.
  const { land, roads } = chartSettings.layers;
  const host = useRef<HTMLDivElement>(null);
  const scene = useRef<Awaited<ReturnType<typeof createSpyglassScene>> | null>(
    null
  );
  const latest = useRef(props);
  const view = useRef<{ x: number; y: number; pixels: number } | null>(null);
  const [status, setStatus] = useState("Unfolding the spyglass…");

  useEffect(() => {
    latest.current = props;
  });

  // Only geometry changes replace the scene. Event handlers and presentation
  // settings reach the existing scene without rebuilding it.
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
          document.fonts.load("16px SpyglassDisplay"),
          document.fonts.load("12px SpyglassBody"),
        ]);
        if (disposed || !host.current) {
          return;
        }
        const current = await createSpyglassScene(host.current, geometry, {
          coastalBuffer: layoutSettings.coastalBuffer,
          developer,
          layers: { land, roads },
          onHover: (value) => latest.current.onHover?.(value),
          onRegionTerritory: (territory) =>
            latest.current.onViewTerritory?.(territory),
          onSelect: (value) => {
            if (latest.current.onSelect) {
              latest.current.onSelect(value);
            } else {
              scene.current?.focus(value?.territory ?? null, value?.file);
            }
          },
          onSettings,
          onTrades: (value) => latest.current.onTrades?.(value),
          onWreck: selectWreck,
        });
        if (disposed) {
          current.dispose();
          return;
        }
        scene.current = current;
        if (mapRef) {
          mapRef.current = current;
        }
        applyState(current, latest.current.state, view.current);
        setStatus("");
      } catch {
        // No frame will come; what waits for one goes ahead.
        releaseFirstFrame();
        if (!disposed) {
          setStatus(
            "The map could not open. Reload in a browser with WebGL enabled."
          );
        }
      }
    };
    open();
    const handleEscape = (event: KeyboardEvent) => {
      if (
        event.key === "Escape" &&
        !event.defaultPrevented &&
        !document.querySelector("dialog[open]")
      ) {
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
      scene.current?.dispose();
      scene.current = null;
      if (mapRef) {
        mapRef.current = null;
      }
      window.removeEventListener("keydown", handleEscape);
    };
  }, [geometry, developer, land, layoutSettings.coastalBuffer, mapRef, roads]);

  // Readings that arrive after load reach the scene without rebuilding it.
  useEffect(() => {
    scene.current?.setData(state.data);
  }, [state.data]);

  useEffect(() => {
    scene.current?.configure(chartSettings);
  }, [chartSettings]);
  useEffect(() => {
    scene.current?.setBelonging(state.belongingLayer);
  }, [state.belongingLayer]);
  useEffect(() => {
    scene.current?.setTerritoryLayout(state.territoryLayout);
  }, [state.territoryLayout]);
  useEffect(() => {
    scene.current?.setDomain(state.domain);
  }, [state.domain]);
  useEffect(() => {
    scene.current?.setConnections(state.showConnections);
    scene.current?.setLegendHeight(state.legendHeight);
    scene.current?.setResponsibility(state.responsibility);
  }, [state.showConnections, state.responsibility, state.legendHeight]);

  return (
    <section aria-label="Interactive spyglass" className="spyglass-map-view">
      <div className="spyglass-map" ref={host} />
      {status && (
        <p className="spyglass-status" role="status">
          {status}
        </p>
      )}
    </section>
  );
}
