import type { BufferGeometry, Object3D, Vector3 } from "three";
import type { FormerPackage, SpyglassData, Territory } from "../data/types";
import type { LabelPlace } from "../layout/labels";
import type { TradeRoute } from "../layout/trade-routes";
import type { ChartSettings } from "../settings/chart-settings";
import type { InkView } from "../view/chart-view";
import type { AppliedState, SelectionRef } from "./apply-plan";
import type { ChartView } from "./chart-camera";
import type { RenderStatus } from "./pipeline";
import type { BelongingHover, ViewState } from "./view-state";

/** What a scene is built with, beside its host and data: read once when the scene is built. */
export interface SpyglassSceneOptions {
  coastalBuffer?: number;
  /** A developer session: the repaint stages and frame submits are timed (`timeStage`). */
  developer?: boolean;
  layers?: ChartSettings["layers"];
  /** The island whose regions the view frames, as the camera moves. */
  onRegionTerritory?: (territory: Territory | null) => void;
  onTrades?: (routes: TradeRoute[]) => void;
}

/**
 * One layer of the chart: named, so its update is timed as `layer:<id>` and
 * it has a node in the composition `describe` reports; disposed in reverse
 * order. A mesh layer has a `group` the scene adds; the labels layer renders
 * to the DOM and has none. Each declares its `kind`, which the composition
 * carries as its node's.
 */
export interface SceneLayer {
  /**
   * Whether the layer is moving on its own: while any layer says so, and
   * motion is not reduced, the scene draws the next frame unasked. A still
   * layer leaves it out.
   */
  animating?: () => boolean;
  dispose: () => void;
  group?: Object3D;
  id: string;
  /** What draws the layer: the labels' DOM, a mark node's batches, or a mesh or a step of the scene's own. */
  kind: "labels" | "layer" | "marks";
  /**
   * The work a coming update can do ahead of its frame, as steps the scene
   * runs in idle time: what the state would have the layer build, cached by
   * identity, so the frame that needs it finds it built.
   */
  prepare?: (view: InkView, state: Readonly<ViewState>) => Iterator<unknown>;
  /** What the layer holds, for its node in the composition: marks, batches, labels placed. */
  stats?: () => Record<string, number>;
  /** Brings the layer up to date with the view and the state; `time` is the clock's seconds since the scene opened. */
  update?: (view: InkView, state: Readonly<ViewState>, time: number) => void;
}

/**
 * One node of the composition as `describe` reports it: a scene layer in
 * update order (`kind` says what draws it), then each stage of the pass
 * graph in its order. `updateMs` is the node's last update on the CPU, or
 * null where nothing is measured: a layer without an update, and every
 * stage, since the GPU times the frame as a whole (`RenderStatus.frameMs`).
 */
export interface CompositionNode {
  counts?: Record<string, number>;
  /** A layer that is drawn or a stage that is built into the current graph. */
  enabled: boolean;
  id: string;
  kind: SceneLayer["kind"] | "stage";
  updateMs: number | null;
}

/** Asked during a repaint, once the labels are placed on the state, for the island to ink under the pointer. */
export type HoverResolver = () => Territory | null;

export type { LabelPlace } from "../layout/labels";

/** Called when Enter or Space is pressed on a focused label item. */
export type LabelActivation = (place: LabelPlace) => void;

/**
 * The scene's handle: `apply` takes one snapshot of the viewer's state,
 * selection included, the commands move the camera, and the rest is what
 * the pointer module reads and sets to hit-test and to preview. Nothing
 * here listens to the pointer.
 */
export interface SpyglassScene {
  /** Reconciles one snapshot: only the fields that changed do work, then one frame is drawn. */
  apply: (state: AppliedState) => void;
  /** The point on the paper under a page point, and the viewport in map units. */
  camera: {
    chartPoint: (page: { clientX: number; clientY: number }) => Vector3 | null;
    view: () => InkView;
  };
  /** The renderer's canvas, which pointer listeners attach to. */
  canvas: HTMLCanvasElement;
  captureView: () => ChartView;
  /** The geometry the scene was built from: wrecks and the chart's extent. */
  data: SpyglassData;
  /** The whole composition, measured: every layer in update order, then every stage. */
  describe: () => CompositionNode[];
  dispose: () => void;
  /**
   * Selects by id and flies there; null is the overview. The snapshot's
   * `selection` reaches it through `apply`, which is the selection's path;
   * the shell calls it with null for its "whole spyglass" command alone.
   */
  focus: (selection: SelectionRef | null) => void;
  focusWreck: (wreck: FormerPackage) => void;
  getRenderStatus: () => RenderStatus;
  /** Asks for a frame; one is drawn per display frame however often it is asked. */
  render: () => void;
  restoreView: (view: ChartView) => void;
  setBelongingHover: (hover: BelongingHover | null) => void;
  setHoverResolver: (resolve: HoverResolver | null) => void;
  /** Hears a keyboard activation of a label item; the pointer module routes it to the same selection path a click takes. */
  setLabelActivation: (activate: LabelActivation | null) => void;
  state: Readonly<ViewState>;
  /** Every island's terrain surface, for picking the land under a point. */
  terrain: BufferGeometry[];
  zoom: (factor: number) => void;
}
