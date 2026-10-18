import { type RefObject, useEffect, useRef, useState } from "react";
import type { FormerPackage, Territory } from "../data/types";
import { attachPointer } from "../interaction/pointer";
import type { SpyglassSelection } from "../interaction/selection";
import type { TradeRoute } from "../layout/trade-routes";
import type { ChartView } from "../scene/chart-camera";
import { createSpyglassScene, type SpyglassScene } from "../scene/scene";
import { releaseFirstFrame } from "../timings";
import type { SpyglassState } from "./spyglass-state";

/** Commands used by the surrounding UI; scene ownership stays in SpyglassMap. */
export type SpyglassMapHandle = Pick<
  SpyglassScene,
  "describe" | "focus" | "focusWreck" | "getRenderStatus" | "zoom"
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

/**
 * Hosts the scene and the pointer over it. The scene is built from the
 * geometry and rebuilt only when it changes; every other part of the state
 * reaches the scene it has through `apply`.
 */
export function SpyglassMap(props: SpyglassMapProps) {
  const { state, mapRef } = props;
  const { geometry, developer, layoutSettings, chartSettings } = state;
  // Primitives, so a new settings object with the same layers (Reset, or any
  // reader setting) reaches the scene through apply, not a rebuild.
  const { land, roads } = chartSettings.layers;
  const host = useRef<HTMLDivElement>(null);
  const scene = useRef<SpyglassScene | null>(null);
  const latest = useRef(props);
  const view = useRef<ChartView | null>(null);
  const [status, setStatus] = useState("Unfolding the spyglass…");

  useEffect(() => {
    latest.current = props;
  });

  // Only geometry changes replace the scene. Event handlers and presentation
  // settings reach the existing scene without rebuilding it.
  useEffect(() => {
    let disposed = false;
    let detachPointer: () => void = () => undefined;
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
          onRegionTerritory: (territory) =>
            latest.current.onViewTerritory?.(territory),
          onTrades: (value) => latest.current.onTrades?.(value),
        });
        if (disposed) {
          current.dispose();
          return;
        }
        detachPointer = attachPointer(current, {
          onHover: (value) => latest.current.onHover?.(value),
          onSelect: (value) => {
            if (latest.current.onSelect) {
              latest.current.onSelect(value);
            } else {
              scene.current?.focus(value?.territory ?? null, value?.file);
            }
          },
          onSettings,
          onWreck: selectWreck,
        }).detach;
        scene.current = current;
        if (mapRef) {
          mapRef.current = current;
        }
        current.apply(latest.current.state);
        const saved: ChartView | null = view.current;
        if (saved) {
          current.restoreView(saved);
        }
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
      detachPointer();
      scene.current?.dispose();
      scene.current = null;
      if (mapRef) {
        mapRef.current = null;
      }
      window.removeEventListener("keydown", handleEscape);
    };
  }, [geometry, developer, land, layoutSettings.coastalBuffer, mapRef, roads]);

  // Everything else the scene draws reaches the scene it has, as one snapshot.
  useEffect(() => {
    scene.current?.apply(state);
  }, [state]);

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
