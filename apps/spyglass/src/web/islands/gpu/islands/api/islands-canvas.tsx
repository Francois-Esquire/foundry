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
  children?: ReactNode;
  className?: string;
  controls?: IslandsControls;
  debug?: IslandsDebug;
  label?: string;
  onError?: (error: IslandsError) => void;
  onFrame?: (frame: IslandsFrame) => void;
  onHover?: (hovered: Described | null) => void;
  onReady?: (islands: Islands | null) => void;
  onSelect?: (selected: Described | null) => void;
  onStats?: (stats: IslandsStats) => void;
  selected?: string | null;
  settings?: Partial<IslandsSettings>;
  view?: IslandsView;
}

export interface IslandsOverlay {
  canvas: HTMLCanvasElement;
  islands: Islands;
}

const IslandsContext = createContext<IslandsOverlay | null>(null);

export function useIslands(): IslandsOverlay | null {
  return useContext(IslandsContext);
}

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
