import type { Chart, Point } from "../../../data/chart";
import type { MapName } from "../maps/map-params";
import type { IslandsSettings } from "../params";
import type { Orbit, Projected } from "../view/camera";
import type { KeyboardMode } from "../view/keys";
import type { Described } from "../view/selection";

export interface IslandsStats {
  buildMs: number | null;
  depths: { floor: number; platform: number; top: number } | null;
  frameMs: number | null;
  hovered: Described | null;
  islands: number;
  levels: number;
  mapMs: Partial<Record<MapName, number>>;
  rebuilt: readonly MapName[];
  segments: number;
  selected: Described | null;
  terrainMs: number | null;
  texels: number;
  waterMs: number | null;
}

export type IslandsView = Orbit;

export interface IslandsControls {
  keyboard?: KeyboardMode;
  reducedMotion?: boolean;
  turn?: boolean;
}

export interface IslandsError {
  error: unknown;
  kind: "lost" | "runtime" | "unsupported";
}

export interface IslandsFrame {
  cpuMs: number;
}

export interface IslandsFrameOptions {
  animate?: boolean;
}

export interface IslandsDebug {
  time: (name: string, ms: number) => void;
}

export interface IslandsOptions {
  chart: Chart;
  controls?: IslandsControls;
  debug?: IslandsDebug;
  settings?: Partial<IslandsSettings>;
  view?: IslandsView;
}

export interface IslandsEvents {
  error: IslandsError;
  frame: IslandsFrame;
  hover: Described | null;
  select: Described | null;
  stats: IslandsStats;
}

export type IslandsEvent = keyof IslandsEvents;

export interface Islands {
  dispose: () => void;
  fit: () => void;
  frame: (target: string | null, options?: IslandsFrameOptions) => void;
  heightAt: (point: Point) => number;
  moduleAt: (id: string) => Point | null;
  on: <E extends IslandsEvent>(
    event: E,
    listener: (value: IslandsEvents[E]) => void
  ) => () => void;
  pixelsPerUnit: (at?: Point) => number;
  project: (point: Point, height?: number) => Projected;
  select: (id: string | null) => void;
  setChart: (chart: Chart) => void;
  setControls: (controls: IslandsControls) => void;
  setSettings: (settings: Partial<IslandsSettings>) => void;
  setView: (view: IslandsView) => void;
  readonly view: IslandsView;
}
