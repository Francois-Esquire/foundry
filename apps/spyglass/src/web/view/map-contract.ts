import type { RenderQuality } from "../settings/chart-settings";

/**
 * What the viewer's UI and whatever draws its map say to each other, apart
 * from the state snapshot (`layout/applied-state.ts`): a selection by id,
 * a camera kept across a rebuild, and the readouts the developer panels
 * show. Nothing here names a renderer, so the map can be replaced under it.
 */

/** What the reader selected, by id: an island, and the file on it when one was. */
export interface SelectionRef {
  fileId?: string;
  territoryId: string;
}

/** What draws one node of the map's composition. */
type MapNodeKind = "labels" | "layer" | "marks" | "stage";

/**
 * One node of the composition as `describe` reports it: a layer in update
 * order (`kind` says what draws it), then each stage of the pass graph in
 * its order. `updateMs` is the node's last update on the CPU, or null where
 * nothing is measured.
 */
export interface CompositionNode {
  counts?: Record<string, number>;
  /** A layer that is drawn or a stage that is built into the current graph. */
  enabled: boolean;
  id: string;
  kind: MapNodeKind;
  updateMs: number | null;
}

/** What the viewer is actually drawing with, for the Chart panel readout. */
export interface RenderStatus {
  /** True once frames ran over budget and the tier stepped down on its own. */
  adapted: boolean;
  backend: "webgpu" | "webgl";
  /** Why the graph stopped, when it failed to build or render. */
  failure: string | null;
  /** Smoothed GPU time per frame in milliseconds, when the device reports it. */
  frameMs: number | null;
  /** Screen-space GI needs a perspective camera; the chart's top-down camera cannot use it. */
  globalIlluminationAvailable: boolean;
  /** False when the quality is off or the pass graph failed and the scene draws directly. */
  postProcessing: boolean;
  /** The tier in use, which is lower than the setting after adapting. */
  quality: RenderQuality;
}

/**
 * The commands the surrounding UI gives the map, through the ref its host
 * fills once the map is up: the app bar's zoom, the overview, and the
 * developer panels' readouts.
 */
export interface MapHandle {
  /** The whole composition, measured: every layer in update order, then every stage. */
  describe: () => CompositionNode[];
  /** Flies to a selection by id; null is the overview. */
  focus: (selection: SelectionRef | null) => void;
  getRenderStatus: () => RenderStatus;
  zoom: (factor: number) => void;
}
