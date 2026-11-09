/**
 * The renderer as a React component, the way a React host draws a chart:
 * it fills its container with a canvas, starts the renderer after mount
 * (WebGPU is browser-only; routes render on the server first), hands prop
 * changes to its setters, and disposes it on unmount. The callbacks may
 * change between renders without restarting it.
 *
 * Its children are drawn over the canvas, in the same React tree: labels,
 * markers, chrome. Each positions itself (absolutely, within the
 * container) and reads the running renderer with `useIslands`, for
 * `project`, `heightAt`, `pixelsPerUnit` and the camera, and redraws with
 * `useIslandsFrame`, once a drawn frame.
 */
import {
  type CSSProperties,
  createContext,
  type ReactNode,
  useContext,
  useEffect,
  useRef,
  useState,
} from "react";
import type { Chart } from "../../../data/chart";
import type { IslandsSettings } from "../params";
import type { Described } from "../view/selection";
import { createIslands, DEFAULT_ISLANDS_SETTINGS } from "./islands";
import type {
  Islands,
  IslandsControls,
  IslandsDebug,
  IslandsError,
  IslandsFrame,
  IslandsStats,
  IslandsView,
} from "./types";

export interface IslandsCanvasProps {
  chart: Chart;
  /** Drawn over the canvas; they read the renderer with `useIslands`. */
  children?: ReactNode;
  /** The container's class. The container always fills its parent, positioned for the overlay. */
  className?: string;
  /** How the reader may move the camera; a new value goes to `setControls`. */
  controls?: IslandsControls;
  /** Where CPU steps are timed; read once, at mount. */
  debug?: IslandsDebug;
  /** The canvas's accessible name: what it shows and how to move it. */
  label?: string;
  /** A failure, by kind; without it, the error is reported to the page. */
  onError?: (error: IslandsError) => void;
  /** Once per drawn frame, with its main-thread time. */
  onFrame?: (frame: IslandsFrame) => void;
  onHover?: (hovered: Described | null) => void;
  /** The renderer once it is created, for `frame`, `fit` and the camera; null once disposed. */
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

/** What the canvas's children read: the running renderer and the canvas it draws on. */
export interface IslandsOverlay {
  /** Its client size is the size `project` answers in, CSS pixels from its top left. */
  canvas: HTMLCanvasElement;
  islands: Islands;
}

const IslandsContext = createContext<IslandsOverlay | null>(null);

/**
 * The renderer under the nearest `<IslandsCanvas>`, and its canvas; null
 * outside one, and before the renderer is created.
 */
export function useIslands(): IslandsOverlay | null {
  return useContext(IslandsContext);
}

/**
 * Calls `listener` once a drawn frame, with the renderer and its canvas,
 * as long as the component is mounted under a running `<IslandsCanvas>`.
 * A still chart draws no frames: what else moves an overlay (its own
 * state) redraws it too. The listener may change between renders.
 */
export function useIslandsFrame(
  listener: (overlay: IslandsOverlay, frame: IslandsFrame) => void
): void {
  const overlay = useIslands();
  const listenerRef = useRef(listener);
  useEffect(() => {
    listenerRef.current = listener;
  });
  useEffect(() => {
    if (!overlay) {
      return;
    }
    return overlay.islands.on("frame", (frame) =>
      listenerRef.current(overlay, frame)
    );
  }, [overlay]);
}

/** The container fills its parent and holds the overlay; the renderer sizes its buffer from the canvas's CSS size. */
const CONTAINER_STYLE: CSSProperties = {
  height: "100%",
  position: "relative",
  width: "100%",
};
const CANVAS_STYLE: CSSProperties = {
  display: "block",
  height: "100%",
  width: "100%",
};

type Callbacks = Pick<
  IslandsCanvasProps,
  "onError" | "onFrame" | "onHover" | "onReady" | "onSelect" | "onStats"
>;

export function IslandsCanvas({
  chart,
  children,
  className,
  controls,
  debug,
  label,
  selected,
  settings,
  view,
  ...callbacks
}: IslandsCanvasProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [overlay, setOverlay] = useState<IslandsOverlay | null>(null);
  const callbacksRef = useRef<Callbacks>(callbacks);
  // What the renderer starts with: the props at mount. Later changes go
  // through the setters below.
  const initialRef = useRef({ chart, controls, debug, settings, view });
  const islands = overlay?.islands;

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
    setOverlay({ canvas, islands: created });
    callbacksRef.current.onReady?.(created);
    return () => {
      for (const stop of unsubscribe) {
        stop();
      }
      created.dispose();
      setOverlay(null);
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

  return (
    <div className={className} style={CONTAINER_STYLE}>
      <canvas aria-label={label} ref={canvasRef} style={CANVAS_STYLE} />
      <IslandsContext.Provider value={overlay}>
        {children}
      </IslandsContext.Provider>
    </div>
  );
}
