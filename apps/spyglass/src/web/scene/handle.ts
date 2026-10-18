import type { BufferGeometry, Object3D, Vector3 } from "three";
import type {
  FormerPackage,
  SpyglassData,
  SpyglassFile,
  Territory,
} from "../data/types";
import type { MapLabel } from "../layout/labels";
import type { TradeRoute } from "../layout/trade-routes";
import type { ChartSettings } from "../settings/chart-settings";
import type { InkView } from "../view/chart-view";
import type { AppliedState } from "./apply-plan";
import type { ChartView } from "./chart-camera";
import type { MarkLayerStats } from "./marks/mark-layer";
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
 * One layer of the chart: named, so its update is timed as `layer:<id>`;
 * disposed in reverse order. A mesh layer has a `group` the scene adds; the
 * labels layer renders to the DOM and has none.
 */
export interface SceneLayer {
  dispose: () => void;
  group?: Object3D;
  id: string;
  update?: (view: InkView, state: Readonly<ViewState>) => void;
}

/** Asked during a repaint, once the labels are placed, for the island to ink under the pointer. */
export type HoverResolver = (labels: readonly MapLabel[]) => Territory | null;

/** What a label names, as a keyboard activation of its item selects it: the island, and the file or region when the item is one. */
export interface LabelPlace {
  compositeId?: string;
  file?: SpyglassFile;
  regionId?: string;
  territory: Territory;
}

/** Called when Enter or Space is pressed on a focused label item. */
export type LabelActivation = (place: LabelPlace) => void;

/**
 * The scene's handle: `apply` takes one snapshot of the viewer's state, the
 * commands move the camera, and the rest is what the pointer module reads
 * and sets to hit-test and to preview. Nothing here listens to the pointer.
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
  dispose: () => void;
  focus: (
    territory: Territory | null,
    file?: SpyglassFile,
    fileIds?: string[]
  ) => void;
  focusWreck: (wreck: FormerPackage) => void;
  getRenderStatus: () => RenderStatus;
  /** What each mark layer holds and last cost to build, bottom to top. */
  markLayerStats: () => MarkLayerStats[];
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
