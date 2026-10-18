import type { SpyglassData } from "../data/types";
import { surveyChart } from "../layout/survey";
import { createTradeChart } from "../layout/trade-chart";
import { visibleRegionTerritory } from "../layout/visible-territory";
import { defaultChartSettings } from "../settings/chart-settings";
import { markLoad, type TimedStage, timeStage } from "../timings";
import { chartTilt, type InkView } from "../view/chart-view";
import { detailVisibility } from "../view/detail-level";
import { createApply } from "./apply-changes";
import { createBelongingReveal } from "./belonging-reveal";
import { createChartCamera } from "./chart-camera";
import { createContinentGround } from "./continent-ground";
import { createFocus } from "./focus";
import { createFrameRenderer } from "./frame-render";
import type {
  HoverResolver,
  SceneLayer,
  SpyglassScene,
  SpyglassSceneOptions,
} from "./handle";
import { createInkCanvases, type InkChart } from "./ink-canvases";
import { createLabelProjector } from "./lettering";
import { markLayers } from "./marks/layers";
import { type MarkChart, markLayerNode } from "./marks/mark-layer";
import { createPaperMaterials } from "./paper-material";
import { createReliefLayer } from "./relief-layer";
import { createRendering } from "./rendering";
import { createRoadLayer } from "./road-layer";
import { createSeaLayer } from "./sea-layer";
import { createLitScene, openRenderer } from "./stage";
import { createTradeLayer } from "./trade-layer";
import { createViewState, type ViewState } from "./view-state";
import { createWreckLayer } from "./wreck-layer";

export type { SpyglassScene, SpyglassSceneOptions } from "./handle";

/** The sea reaches this far past the chart, so a reader may pan out to open water. */
const panRoom = 2.2;

/** Trades show while nothing is selected on an island and no overlay is drawn. */
const tradesVisible = (state: Readonly<ViewState>) =>
  !(
    state.selectedFile ||
    state.belonging?.parents?.length ||
    state.responsibility
  );

/**
 * Builds the chart in the host and returns its handle. The scene owns the
 * renderer, the camera, the mesh layers, the ink canvases and the pass
 * graph; it listens to nothing but the viewport, and draws a frame only when
 * asked.
 */
export async function createSpyglassScene(
  host: HTMLElement,
  data: SpyglassData,
  options: SpyglassSceneOptions
): Promise<SpyglassScene> {
  const {
    coastalBuffer = 32,
    developer = false,
    layers = defaultChartSettings.layers,
    onRegionTerritory,
    onTrades,
  } = options;
  const timed = <T>(stage: TimedStage, work: () => T): T =>
    timeStage(developer, stage, work);
  const renderer = await openRenderer(host);
  const scene = createLitScene();
  const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
  const seaData = {
    ...data,
    height: data.height * 1.65 * panRoom,
    width: data.width * 1.95 * panRoom,
  };
  const chart = surveyChart(data, coastalBuffer, layers);
  const sea = createSeaLayer({
    chart: data,
    coasts: chart.coasts,
    sea: seaData,
    shore: chart.shore,
  });
  const materials = createPaperMaterials();
  const inkCanvases = createInkCanvases({
    data,
    developer,
    size: {
      height: Math.max(1, host.clientHeight),
      width: Math.max(1, host.clientWidth),
    },
  });
  const relief = createReliefLayer(
    data,
    materials.paper,
    inkCanvases.inkTexture()
  );
  markLoad("spyglass:terrain-built");
  const trade = createTradeChart(data, chart.continents, layers.roads);
  const tradeLayer = createTradeLayer(data);
  const roads = createRoadLayer(trade.roads);
  const wrecks = createWreckLayer(data.formerPackages ?? []);
  const ground = createContinentGround(chart.continents, materials.paper);
  const markChart: MarkChart = {
    ripples: chart.ripples,
    sea: { height: seaData.height, width: seaData.width },
  };
  const markNodes = markLayers.map((layer, order) =>
    markLayerNode(layer, {
      chart: markChart,
      order,
      pixelRatio: () => renderer.getPixelRatio(),
    })
  );
  /** The chart's mesh layers, bottom to top of its z-order. */
  const sceneLayers: SceneLayer[] = [
    sea,
    ...markNodes,
    {
      dispose: () => undefined,
      group: inkCanvases.plane,
      id: "ink",
      update: (view) => inkCanvases.update(view),
    },
    { dispose: wrecks.dispose, group: wrecks.group, id: "wrecks" },
    {
      dispose: relief.dispose,
      group: relief.group,
      id: "relief",
      update: (view) => relief.setView(view),
    },
    {
      dispose: roads.dispose,
      group: roads.group,
      id: "roads",
      update: (view, current) => {
        roads.group.visible = tradesVisible(current) && layers.roads;
        roads.update(view.pixelsPerUnit);
      },
    },
    {
      dispose: tradeLayer.dispose,
      group: tradeLayer.group,
      id: "trades",
      update: (_view, current) => {
        tradeLayer.group.visible =
          tradesVisible(current) && current.settings.trade;
      },
    },
    { dispose: ground.dispose, group: ground.group, id: "ground" },
    {
      dispose: () => undefined,
      group: inkCanvases.lettering.mesh,
      id: "lettering",
      update: (view) => inkCanvases.lettering.update(view),
    },
  ];
  for (const layer of sceneLayers) {
    scene.add(layer.group);
  }

  const state = createViewState(data, defaultChartSettings);
  const camera = createChartCamera({
    canvas: renderer.domElement,
    data,
    host,
    onChange: () => render(),
    reducedMotion,
    sea: { height: seaData.height, panRoom, width: seaData.width },
  });
  const rendering = createRendering({
    camera,
    host,
    paper: materials,
    render: () => render(),
    renderer,
    scene,
  });
  rendering.configure(state.settings.rendering);
  const inkChart: InkChart = {
    boundaries: chart.boundaries,
    developer,
    project: createLabelProjector(relief.fieldFor, chartTilt),
    reducedMotion,
    topography: chart.topography,
  };
  let hoverResolver: HoverResolver | null = null;
  let reportedRegionTerritory: string | null = null;
  const reportRegionTerritory = (view: InkView) => {
    const territory =
      visibleRegionTerritory(state.drawingData.territories, view) ?? null;
    if (territory?.id !== reportedRegionTerritory) {
      reportedRegionTerritory = territory?.id ?? null;
      onRegionTerritory?.(territory);
    }
  };
  /** Draws one frame: the chart is still, so a frame is drawn only when a repaint asks. */
  const drawMap = () => {
    camera.constrain();
    const view = camera.view();
    reportRegionTerritory(view);
    state.visibility = detailVisibility(
      state.visibility,
      view.pixelsPerUnit,
      (state.responsibility?.composition?.marks.length ?? 0) > 0
    );
    for (const layer of sceneLayers) {
      if (layer.update) {
        timed(`layer:${layer.id}`, () => layer.update?.(view, state));
      }
    }
    state.labels = inkCanvases.repaint({
      chart: inkChart,
      hovered: hoverResolver ?? undefined,
      state,
      view,
    });
    // CPU encode and submit only; GPU time is not measured.
    timed("render-submit", rendering.render);
    markLoad("spyglass:first-frame");
  };
  const frameRenderer = createFrameRenderer(drawMap);
  const render = frameRenderer.request;
  const resize = () => {
    camera.resize(state.selectedFile !== null);
    const { clientWidth, clientHeight } = host;
    renderer.setSize(clientWidth, clientHeight);
    relief.setMap(
      inkCanvases.resize(clientWidth, clientHeight, renderer.getPixelRatio())
    );
    render();
  };
  const observer = new ResizeObserver(resize);
  observer.observe(host);
  resize();
  const motionChanged = () => {
    if (state.responsibility) {
      render();
    }
  };
  reducedMotion.addEventListener("change", motionChanged);
  const reveal = createBelongingReveal({ reducedMotion, render, state });
  const { focus, focusWreck } = createFocus({
    camera,
    data,
    onTrades,
    state,
    trade,
    tradeLayer,
  });
  return {
    apply: createApply({
      configureRendering: rendering.configure,
      data,
      focus,
      render,
      setBelonging: reveal.set,
      state,
    }),
    camera: { chartPoint: camera.chartPoint, view: camera.view },
    canvas: renderer.domElement,
    captureView: camera.captureView,
    data,
    dispose() {
      frameRenderer.dispose();
      reveal.dispose();
      observer.disconnect();
      reducedMotion.removeEventListener("change", motionChanged);
      camera.dispose();
      for (const layer of sceneLayers.toReversed()) {
        layer.dispose();
      }
      inkCanvases.dispose();
      materials.dispose();
      rendering.dispose();
      renderer.dispose();
      renderer.domElement.remove();
    },
    focus,
    focusWreck,
    getRenderStatus: rendering.status,
    markLayerStats: () => markNodes.map((node) => node.stats()),
    render,
    restoreView(view) {
      camera.restoreView(view);
      render();
    },
    setBelongingHover(hover) {
      state.belongingHover = hover;
      render();
    },
    setHoverResolver(resolve) {
      hoverResolver = resolve;
    },
    state,
    terrain: relief.geometries,
    zoom(factor) {
      camera.zoom(factor);
      render();
    },
  };
}
