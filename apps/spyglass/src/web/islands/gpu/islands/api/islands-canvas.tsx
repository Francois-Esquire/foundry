/**
 * The renderer as a React component: it owns the canvas, starts the
 * renderer after mount (WebGPU is browser-only; routes render on the
 * server first), hands prop changes to its setters, and disposes it on
 * unmount. The callbacks may change between renders without restarting it.
 */
import { useEffect, useRef, useState } from "react";
import type { Chart } from "../../../data/chart";
import type { IslandsSettings } from "../params";
import type { Described } from "../view/selection";
import {
  createIslands,
  DEFAULT_ISLANDS_SETTINGS,
  type Islands,
  type IslandsControls,
  type IslandsDebug,
  type IslandsError,
  type IslandsFrame,
  type IslandsStats,
  type IslandsView,
} from "./islands";

export interface IslandsCanvasProps {
  chart: Chart;
  className?: string;
  /** How the reader may move the camera; a new value goes to `setControls`. */
  controls?: IslandsControls;
  /** Where CPU steps are timed; read once, at mount. */
  debug?: IslandsDebug;
  /** A failure, by kind; without it, the error is reported to the page. */
  onError?: (error: IslandsError) => void;
  /** Once per drawn frame, with its main-thread time. */
  onFrame?: (frame: IslandsFrame) => void;
  onHover?: (hovered: Described | null) => void;
  /** The renderer once it is created, for `project`, `fit` and the camera; null once disposed. */
  onReady?: (islands: Islands | null) => void;
  onSelect?: (selected: Described | null) => void;
  onStats?: (stats: IslandsStats) => void;
  /** The chosen island's or ring's chart id; null for none, left out to leave it to clicks. */
  selected?: string | null;
  /** Over the defaults: a key left out is at its default. */
  settings?: Partial<IslandsSettings>;
  /**
   * The camera to open at (without it, the chart is fitted); a new value
   * later moves the camera there, as `setView` does.
   */
  view?: IslandsView;
}

type Callbacks = Pick<
  IslandsCanvasProps,
  "onError" | "onFrame" | "onHover" | "onReady" | "onSelect" | "onStats"
>;

export function IslandsCanvas({
  chart,
  className,
  controls,
  debug,
  selected,
  settings,
  view,
  ...callbacks
}: IslandsCanvasProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [islands, setIslands] = useState<Islands | null>(null);
  const callbacksRef = useRef<Callbacks>(callbacks);
  // What the renderer starts with: the props at mount. Later changes go
  // through the setters below.
  const initialRef = useRef({ chart, controls, debug, settings, view });

  useEffect(() => {
    callbacksRef.current = callbacks;
  });

  useEffect(() => {
    const canvas: HTMLCanvasElement | null = canvasRef.current;
    if (!canvas) {
      return;
    }
    const initial = initialRef.current;
    const created = createIslands(canvas, {
      chart: initial.chart,
      controls: initial.controls,
      debug: initial.debug,
      settings: initial.settings,
      view: initial.view,
    });
    const unsubscribe = [
      created.on("error", (failure) => {
        const { onError } = callbacksRef.current;
        if (onError) {
          onError(failure);
        } else {
          reportError(failure.error);
        }
      }),
      created.on("frame", (frame) => callbacksRef.current.onFrame?.(frame)),
      created.on("hover", (hovered) => callbacksRef.current.onHover?.(hovered)),
      created.on("select", (chosen) => callbacksRef.current.onSelect?.(chosen)),
      created.on("stats", (stats) => callbacksRef.current.onStats?.(stats)),
    ];
    setIslands(created);
    callbacksRef.current.onReady?.(created);
    return () => {
      for (const stop of unsubscribe) {
        stop();
      }
      created.dispose();
      setIslands(null);
      callbacksRef.current.onReady?.(null);
    };
  }, []);

  useEffect(() => {
    islands?.setChart(chart);
  }, [islands, chart]);

  useEffect(() => {
    islands?.setSettings({ ...DEFAULT_ISLANDS_SETTINGS, ...settings });
  }, [islands, settings]);

  useEffect(() => {
    if (controls) {
      islands?.setControls(controls);
    }
  }, [islands, controls]);

  useEffect(() => {
    // The first view is the one the renderer opened at.
    if (view && view !== initialRef.current.view) {
      islands?.setView(view);
    }
  }, [islands, view]);

  useEffect(() => {
    if (selected !== undefined) {
      islands?.select(selected);
    }
  }, [islands, selected]);

  return <canvas className={className} ref={canvasRef} />;
}
