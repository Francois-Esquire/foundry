/**
 * The renderer's public types, in one place: what a host hands it, what it
 * reports, and the handle it gives (`Islands`). The engine (islands.ts) and
 * the component (islands-canvas.tsx) both take them from here; the entry
 * (index.ts) re-exports those hosts use.
 */
import type { Chart, Point } from "../../../data/chart";
import type { MapName } from "../maps/map-params";
import type { IslandsSettings } from "../params";
import type { Orbit, Projected } from "../view/camera";
import type { KeyboardMode } from "../view/keys";
import type { Described } from "../view/selection";

export interface IslandsStats {
  /** GPU milliseconds of the last rebuild, from its start to its finish. */
  buildMs: number | null;
  /** The sea floor's derived depths at the current settings (sea-params.ts `seaDepthsOf`). */
  depths: { floor: number; platform: number; top: number } | null;
  /** Main-thread milliseconds the last drawn frame took to encode and submit; null before the first. */
  frameMs: number | null;
  /** What the pointer is over: an island or a ring, in the chart's terms. */
  hovered: Described | null;
  islands: number;
  /** The levels the chart's banks stand on (banks.ts `banksOf`). */
  levels: number;
  /** Main-thread milliseconds each map took to encode, at its last rebuild. */
  mapMs: Partial<Record<MapName, number>>;
  /** The maps the last rebuild rebuilt. */
  rebuilt: readonly MapName[];
  /** Coast segments the distance map is built from. */
  segments: number;
  /** What the last click chose: an island or a ring, in the chart's terms. */
  selected: Described | null;
  /** The terrain pass's GPU milliseconds; null without timestamps. */
  terrainMs: number | null;
  /** Texels a side of every map. */
  texels: number;
  /** The water composite's GPU milliseconds; null without timestamps. */
  waterMs: number | null;
}

/** The camera: an orbit over the chart (view/camera.ts). */
export type IslandsView = Orbit;

/** How the reader may move the camera and where its keys listen. */
export interface IslandsControls {
  /**
   * Where the camera's keys and Escape listen: the whole window
   * (the default), the canvas alone (made focusable with `tabIndex` 0
   * unless the host set one), or nowhere. In every mode a key typed into a
   * field or pressed inside an open `<dialog>` is left alone.
   */
  keyboard?: KeyboardMode;
  /**
   * Whether the camera flies (`frame`, a module's `select`) or jumps.
   * Left out, the page's `prefers-reduced-motion` decides at each flight.
   */
  reducedMotion?: boolean;
  /** Whether drag and keys may turn the camera; false holds it looking north. True by default. */
  turn?: boolean;
}

/**
 * A failure, by kind: `unsupported` when the browser has no WebGPU or no
 * adapter at start, `lost` when the GPU device is lost, `runtime` for any
 * other. `error` is what was thrown or reported, as it came.
 */
export interface IslandsError {
  error: unknown;
  kind: "lost" | "runtime" | "unsupported";
}

/** A drawn frame. */
export interface IslandsFrame {
  /** Main-thread milliseconds the frame took to encode and submit. */
  cpuMs: number;
}

export interface IslandsFrameOptions {
  /** Fly there (the default) or jump; a reduced-motion setting always jumps. */
  animate?: boolean;
}

/**
 * Where the renderer reports CPU steps worth timing, by name: the lab's
 * debug panel, or anything with the same shape.
 */
export interface IslandsDebug {
  time: (name: string, ms: number) => void;
}

export interface IslandsOptions {
  chart: Chart;
  /** How the reader may move the camera; `setControls` changes it later. */
  controls?: IslandsControls;
  debug?: IslandsDebug;
  /** Over the defaults; keys left out keep their defaults. */
  settings?: Partial<IslandsSettings>;
  /** The camera to open at; without it, the chart is fitted. */
  view?: IslandsView;
}

/** What each event hands its listeners. */
export interface IslandsEvents {
  error: IslandsError;
  /** Once per drawn frame, once it is submitted. */
  frame: IslandsFrame;
  /** What the pointer is over, when that changes. */
  hover: Described | null;
  /** What is chosen, when that changes: by a click, Escape, `select`, or a new chart. */
  select: Described | null;
  /** Every readout, whenever one changes. */
  stats: IslandsStats;
}

export type IslandsEvent = keyof IslandsEvents;

export interface Islands {
  /** Stops drawing and frees the GPU and every listener. */
  dispose: () => void;
  /** Frames the whole chart, looking north. */
  fit: () => void;
  /**
   * Takes the camera over an island, a ring or a module by chart id,
   * keeping its turn and tilt, close enough that it fills most of the
   * view; null frames the whole chart as `fit` does. Flies there, eased,
   * unless `animate` is false or motion is reduced (`IslandsControls`);
   * any input takes over. An id naming nothing leaves the camera.
   */
  frame: (target: string | null, options?: IslandsFrameOptions) => void;
  /**
   * The terrain's height at a chart point, chart units above sea level,
   * for `project`: on land, the land's profile the height map bakes,
   * worked out on the CPU from the coasts (land/height-at.ts); at sea, an
   * approximation (negative): the beach's fall, then the top bank's depth,
   * the shallowest the floor stands, since the bathymetry lives only on
   * the GPU. Labels on the water take `Math.max(0, heightAt(point))`.
   */
  heightAt: (point: Point) => number;
  on: <E extends IslandsEvent>(
    event: E,
    listener: (value: IslandsEvents[E]) => void
  ) => () => void;
  /**
   * CSS pixels a chart unit spans across the view, at the orbit's target
   * or at a chart point (on the terrain, `heightAt`); 0 for a point behind
   * the eye. The view's scale for labels and scale bars.
   */
  pixelsPerUnit: (at?: Point) => number;
  /**
   * A chart point (`height` above sea level, chart units) on the canvas
   * as the camera stands, for labels laid over it. `x` and `y` are always
   * finite: a point behind the eye is not `visible`, and it and any point
   * far off the canvas are held within a canvas's size of its edges.
   */
  project: (point: Point, height?: number) => Projected;
  /**
   * Chooses an island, a ring, a module by its chart id, or a building
   * by the `building:<id>` a "select" event gave, as a click would; null
   * lets go. A module or a building shows as its island chosen (there is
   * no highlight of its own) and is described as itself, and the camera
   * frames a module as `frame` does. Naming the island or a file of the
   * building chosen keeps the building. Ignored while the `selection`
   * setting is off, except null.
   */
  select: (id: string | null) => void;
  /** Replaces the chart: replans the world and rebuilds every map. */
  setChart: (chart: Chart) => void;
  /** Changes how the reader may move the camera; options left out keep their values. */
  setControls: (controls: IslandsControls) => void;
  /** Changes some settings; the rest keep their values. */
  setSettings: (settings: Partial<IslandsSettings>) => void;
  setView: (view: IslandsView) => void;
  /** The camera as it stands. */
  readonly view: IslandsView;
}
