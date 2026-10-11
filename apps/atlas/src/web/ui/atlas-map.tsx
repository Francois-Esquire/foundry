import { type RefObject, useEffect, useRef, useState } from "react";
import { type AtlasSelection, createAtlasScene } from "../scene/scene";
import type { TradeRoute } from "../trade-routes";
import type { FormerPackage, Territory } from "../types";
import type { AtlasState } from "./atlas-state";

/** Commands used by the surrounding UI; scene ownership stays in AtlasMap. */
export type AtlasMapHandle = Pick<
  Awaited<ReturnType<typeof createAtlasScene>>,
  "focus" | "focusWreck" | "getRenderStatus" | "pinRegion" | "zoom"
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

/** Presentation state and any saved camera reach a fresh scene. */
function applyState(
  current: Awaited<ReturnType<typeof createAtlasScene>>,
  next: AtlasState,
  view: { x: number; y: number; pixels: number } | null
) {
  current.configure(next.chartSettings);
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

export function AtlasMap(props: AtlasMapProps) {
  const { state, mapRef } = props;
  const { data, developer, layoutSettings, chartSettings } = state;
  // Primitives, so a new settings object with the same layers (Reset, or any
  // reader setting) reaches the scene through configure, not a rebuild.
  const { land, roads } = chartSettings.layers;
  const host = useRef<HTMLDivElement>(null);
  const scene = useRef<Awaited<ReturnType<typeof createAtlasScene>> | null>(
    null
  );
  const latest = useRef(props);
  const view = useRef<{ x: number; y: number; pixels: number } | null>(null);
  const [status, setStatus] = useState("Unfolding the atlas…");

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
          document.fonts.load("16px AtlasDisplay"),
          document.fonts.load("12px AtlasBody"),
        ]);
        if (disposed || !host.current) {
          return;
        }
        const current = await createAtlasScene(host.current, data, {
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
      scene.current?.dispose();
      scene.current = null;
      if (mapRef) {
        mapRef.current = null;
      }
      window.removeEventListener("keydown", handleEscape);
    };
  }, [data, developer, land, layoutSettings.coastalBuffer, mapRef, roads]);

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
    <section aria-label="Interactive atlas" className="atlas-map-view">
      <div className="atlas-map" ref={host} />
      {status && (
        <p className="atlas-status" role="status">
          {status}
        </p>
      )}
    </section>
  );
}
