import { Mesh, MeshBasicMaterial, PlaneGeometry } from "three";
import { paperThickness } from "../data/bindings";
import type { SpyglassData, Territory } from "../data/types";
import type { BoundaryLayers } from "../layout/boundaries";
import type { MapLabel } from "../layout/labels";
import type { ContourLine } from "../layout/topography";
import { type TimedStage, timeStage } from "../timings";
import type { InkView } from "../view/chart-view";
import type { InkOptions } from "./ink/state";
import { createInkTexture } from "./ink-texture";
import { createLettering } from "./lettering";
import { paintInk } from "./paint-map";
import { copySeaInk } from "./sea-ink";
import { drawnBelonging, type ViewState } from "./view-state";

/** Largest ink canvas edge; every supported backend allows a texture this wide. */
const maxTextureSize = 4096;

/** What every repaint reads beside the view state: the scene's fixed geometry and its session. */
export interface InkChart {
  boundaries: BoundaryLayers;
  developer: boolean;
  project: (label: MapLabel) => MapLabel;
  reducedMotion: MediaQueryList;
  topography: ContourLine[];
}

/** One repaint of the ink: the chart, the state, the view, and who is hovered. */
export interface InkFrame {
  chart: InkChart;
  hovered: ((labels: readonly MapLabel[]) => Territory | null) | undefined;
  state: Readonly<ViewState>;
  view: InkView;
}

/**
 * The Canvas2D ink the chart still carries: the ink canvas every layer paints
 * into, its copy with the land cut out that the ink plane shows over the sea,
 * and the lettering overlay. Each is a texture redrawn at the viewport's
 * resolution. Phase 5 removes all of it.
 */
export function createInkCanvases(options: {
  data: SpyglassData;
  developer: boolean;
  /** The pixel size to open at, before the first fit to the viewport: the host's. */
  size: { height: number; width: number };
}) {
  const { data, developer, size } = options;
  const timed = <T>(stage: TimedStage, work: () => T): T =>
    timeStage(developer, stage, work);
  const ink = document.createElement("canvas");
  ink.width = size.width;
  ink.height = size.height;
  paintInk(ink, { data });
  let inkTexture = createInkTexture(ink);
  const seaInk = document.createElement("canvas");
  let seaInkTexture = createInkTexture(seaInk);
  const material = new MeshBasicMaterial({
    depthTest: false,
    depthWrite: false,
    map: seaInkTexture,
    transparent: true,
  });
  const plane = new Mesh(new PlaneGeometry(1, 1), material);
  plane.position.z = paperThickness + 0.02;
  plane.renderOrder = 1;
  const lettering = createLettering();
  return {
    dispose() {
      lettering.dispose();
      seaInkTexture.dispose();
      plane.geometry.dispose();
      material.dispose();
      inkTexture.dispose();
    },
    /** The ink as painted, which the relief projects onto the land. */
    inkTexture: () => inkTexture,
    lettering,
    /** The sea's ink: the ink with the land cut out, shown flat over the water. */
    plane,
    /** Paints the frame's ink and lettering, cuts the sea copy, and marks the textures for upload; the labels placed. */
    repaint(frame: InkFrame): MapLabel[] {
      const labels = timed("ink", () =>
        paintInk(ink, inkOptions(frame, lettering.canvas))
      );
      timed("sea-ink", () =>
        copySeaInk(seaInk, ink, frame.state.drawingData, frame.view)
      );
      seaInkTexture.needsUpdate = true;
      inkTexture.needsUpdate = true;
      return labels;
    },
    /** Reallocates the canvases at the viewport's device pixels; the new ink texture, for the relief to project. */
    resize(width: number, height: number, pixelRatio: number) {
      ink.width = Math.min(maxTextureSize, Math.round(width * pixelRatio));
      ink.height = Math.min(maxTextureSize, Math.round(height * pixelRatio));
      inkTexture.dispose();
      inkTexture = createInkTexture(ink);
      lettering.resize(ink.width, ink.height);
      seaInk.width = ink.width;
      seaInk.height = ink.height;
      seaInkTexture.dispose();
      seaInkTexture = createInkTexture(seaInk);
      material.map = seaInkTexture;
      return inkTexture;
    },
    /** Lays the ink plane under the view. */
    update(view: InkView) {
      plane.scale.set(view.width, view.height, 1);
      plane.position.set(view.x, -view.y, paperThickness + 0.02);
    },
  };
}

function inkOptions(
  { chart, hovered, state, view }: InkFrame,
  letteringCanvas: HTMLCanvasElement
): InkOptions {
  const { settings } = state;
  return {
    belonging: drawnBelonging(state),
    boundaries: { layers: chart.boundaries, visible: settings.boundaries },
    data: state.drawingData,
    developer: chart.developer,
    domain: state.domain,
    fileId: state.selectedFile,
    hovered,
    legendHeight: state.legendHeight,
    lettering: { canvas: letteringCanvas, project: chart.project },
    matches: state.matches,
    responsibility: state.responsibility && {
      ...state.responsibility,
      reducedMotion: chart.reducedMotion.matches,
    },
    selected: state.selected,
    showConnections: state.showConnections,
    streams: settings.streams,
    topography: settings.contours ? chart.topography : [],
    view,
  };
}
