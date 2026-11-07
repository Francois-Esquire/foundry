import {
  type ComponentType,
  lazy,
  type MouseEvent,
  type MouseEventHandler,
  useCallback,
} from "react";
import {
  detailToggles,
  type SceneLayerId,
} from "../settings/scene-composition";
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
    <fieldset
      aria-label="Map navigation"
      className="spyglass-map-navigation"
      disabled={!actions.sceneReady}
    >
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

/** Labels and the ruler: each a pressed button over a group of the composition's layers, pressed while all of them show. */
function MapDetails({ actions, state }: AppBarContext) {
  const { composition } = state.chartSettings;
  const toggle = useCallback(
    ({ currentTarget }: MouseEvent<HTMLButtonElement>) => {
      const layers: readonly SceneLayerId[] =
        detailToggles.find(({ id }) => id === currentTarget.value)?.layers ??
        [];
      actions.settings((current) => {
        const shown = layers.every((id) => current.composition[id]);
        const next = { ...current.composition };
        for (const id of layers) {
          next[id] = !shown;
        }
        return { ...current, composition: next };
      });
    },
    [actions.settings]
  );
  return (
    <fieldset aria-label="Map details" className="spyglass-map-details">
      {detailToggles.map(({ id, label, layers }) => (
        <button
          aria-pressed={layers.every((layer) => composition[layer])}
          key={id}
          onClick={toggle}
          title={`Show ${label.toLowerCase()}`}
          type="button"
          value={id}
        >
          {label}
        </button>
      ))}
    </fieldset>
  );
}

/** Immediate actions stay in the bar; adding an entry extends it toward the left. */
export const appBarEntries: readonly AppBarEntry[] = [
  ...(import.meta.env.DEV
    ? [
        {
          component: lazy(() => import("./developer-frame-rate")),
          id: "frame-rate",
        },
      ]
    : []),
  { component: MapDetails, id: "details" },
  { component: MapNavigation, id: "navigation" },
];

const DevelopmentStats = import.meta.env.DEV
  ? lazy(() =>
      import("./developer-tools").then((module) => ({
        default: module.DeveloperStats,
      }))
    )
  : null;

function Appearance({ actions, state }: ChromeContext) {
  return (
    <ChartSettingsPanel
      disabled={!actions.sceneReady}
      onChange={actions.settings}
      settings={state.chartSettings}
    />
  );
}

export const chromeEntries: readonly ChromeEntry[] = [
  {
    component: Appearance,
    description: "The camera's angle and the sea's waves.",
    id: "rendering",
    title: "Rendering",
  },
  ...(DevelopmentStats
    ? [
        {
          component: DevelopmentStats,
          description:
            "The renderer's status, and the map's layers with their update times.",
          id: "stats",
          title: "Stats",
        },
      ]
    : []),
];
