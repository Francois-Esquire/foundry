import {
  type ComponentType,
  lazy,
  type MouseEventHandler,
  useCallback,
} from "react";
import { ChartSettingsPanel } from "./chart-settings-panel";
import type { SpyglassState } from "./spyglass-state";
import type { useSpyglassState } from "./use-spyglass-state";

export interface ChromeContext {
  actions: Omit<ReturnType<typeof useSpyglassState>, "state">;
  state: SpyglassState;
}

/** Add a section here to extend the compass sidebar without changing its shell. */
export interface ChromeEntry {
  component: ComponentType<ChromeContext>;
  description: string;
  id: string;
  title: string;
}

export interface AppBarContext extends ChromeContext {
  onOpen: MouseEventHandler<HTMLButtonElement>;
}

export interface AppBarEntry {
  component: ComponentType<AppBarContext>;
  id: string;
}

function MapNavigation({ actions }: AppBarContext) {
  const zoomOut = useCallback(
    () => actions.scene.current?.zoom(1 / 1.35),
    [actions.scene]
  );
  const zoomIn = useCallback(
    () => actions.scene.current?.zoom(1.35),
    [actions.scene]
  );
  return (
    <fieldset aria-label="Map navigation" className="spyglass-map-navigation">
      <button
        aria-label="Zoom out"
        onClick={zoomOut}
        title="Zoom out"
        type="button"
      >
        −
      </button>
      <button
        aria-label="Whole spyglass"
        onClick={actions.home}
        title="Whole spyglass"
        type="button"
      >
        <svg
          aria-hidden="true"
          fill="none"
          height="18"
          stroke="currentColor"
          strokeWidth="1.5"
          viewBox="0 0 24 24"
          width="18"
        >
          <path d="M4 9V4h5m6 0h5v5m0 6v5h-5M9 20H4v-5" />
          <circle cx="12" cy="12" r="3" />
        </svg>
      </button>
      <button
        aria-label="Zoom in"
        onClick={zoomIn}
        title="Zoom in"
        type="button"
      >
        +
      </button>
    </fieldset>
  );
}

function MapMode({ actions, state }: AppBarContext) {
  const toggle = useCallback(
    () => actions.mapLayer(state.mapLayer === "files" ? "belonging" : "files"),
    [actions.mapLayer, state.mapLayer]
  );
  return (
    <button
      aria-label={state.mapLayer === "files" ? "Show belonging" : "Show files"}
      onClick={toggle}
      title="Switch map layer"
      type="button"
    >
      {state.mapLayer === "files" ? "Files" : "Belonging"}
    </button>
  );
}

/** Immediate actions stay in the bar; adding an entry extends it toward the left. */
export const appBarEntries: readonly AppBarEntry[] = [
  { component: MapNavigation, id: "navigation" },
  { component: MapMode, id: "map-mode" },
  ...(import.meta.env.DEV
    ? [
        {
          component: lazy(() => import("./developer-frame-rate")),
          id: "frame-rate",
        },
      ]
    : []),
];

function MapLayers({ actions, state }: ChromeContext) {
  return (
    <ChartSettingsPanel
      onChange={actions.settings}
      onReset={actions.reset}
      scene={actions.scene}
      settings={state.chartSettings}
    />
  );
}

export const chromeEntries: readonly ChromeEntry[] = [
  {
    component: MapLayers,
    description: "Choose what the chart reveals",
    id: "rendering",
    title: "Layers & atmosphere",
  },
  ...(import.meta.env.DEV
    ? [
        {
          component: lazy(() => import("./developer-tools")),
          description: "Performance, layout & rendering",
          id: "development",
          title: "Development",
        },
      ]
    : []),
];
