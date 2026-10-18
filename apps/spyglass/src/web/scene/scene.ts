import type { SpyglassData } from "../data/types";
import { surveyChart } from "../layout/survey";
import { createTradeChart } from "../layout/trade-chart";
import { visibleRegionTerritory } from "../layout/visible-territory";
import { defaultChartSettings } from "../settings/chart-settings";
import { markLoad, type TimedStage, timeStage } from "../timings";
import type { InkView } from "../view/chart-view";
import { detailVisibility } from "../view/detail-level";
import { createApply } from "./apply-changes";
import type { AppliedState } from "./apply-plan";
import { createBelongingReveal } from "./belonging-reveal";
import { createChartCamera } from "./chart-camera";
import { tickClock } from "./clock";
import { createContinentGround } from "./continent-ground";
import { createFocus } from "./focus";
import { createFrameRenderer, sceneAnimating } from "./frame-render";
import type {
  CompositionNode,
  HoverResolver,
  SceneLayer,
  SpyglassScene,
  SpyglassSceneOptions,
} from "./handle";
import { runIdle } from "./idle";
import { createLabelsLayer } from "./labels/labels-layer";
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
import { createWeatherLayer } from "./weather";
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
 * renderer, the camera, the mesh and mark layers, the labels layer over the
 * canvas and the pass graph; it listens to nothing but the viewport, and
 * draws a frame only when asked.
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
  const weather = createWeatherLayer();
  const materials = createPaperMaterials();
  const relief = createReliefLayer(data, materials.paper);
  markLoad("spyglass:terrain-built");
  const trade = createTradeChart(data, chart.continents, layers.roads);
  const tradeLayer = createTradeLayer(data);
  const roads = createRoadLayer(trade.roads);
  const wrecks = createWreckLayer(data.formerPackages ?? []);
  const ground = createContinentGround(chart.continents, materials.paper);
  const markChart: MarkChart = {
    boundaries: chart.boundaries,
    ripples: chart.ripples,
    sea: { height: seaData.height, width: seaData.width },
    topography: chart.topography,
  };
  const markNodes = markLayers.map((layer, order) =>
    markLayerNode(layer, {
      chart: markChart,
      order,
      pixelRatio: () => renderer.getPixelRatio(),
    })
  );
  const state = createViewState(data, defaultChartSettings);
  const camera = createChartCamera({
    canvas: renderer.domElement,
    data,
    host,
    onChange: () => render(),
    reducedMotion,
    sea: { height: seaData.height, panRoom, width: seaData.width },
  });
  const labels = createLabelsLayer({
    camera: camera.camera,
    host,
    pixelRatio: () => renderer.getPixelRatio(),
    publish: (placed) => {
      state.labels = placed;
    },
  });
  /**
   * The chart's layers in the order they update: the labels first, since
   * their update places the frame's labels on the state and the island
   * under the pointer is resolved from them before any mark layer runs;
   * then the drawn layers, bottom to top of the z-order. The labels are
   * elements over the canvas, so their place in this list is not their
   * depth: they lie over everything. The weather draws nothing itself: the
   * sea and the paper read its uniforms, and it is the layer that animates.
   */
  const sceneLayers: SceneLayer[] = [
    labels,
    sea,
    weather,
    ...markNodes,
    { dispose: wrecks.dispose, group: wrecks.group, id: "wrecks" },
    { dispose: relief.dispose, group: relief.group, id: "relief" },
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
  ];
  for (const layer of sceneLayers) {
    if (layer.group) {
      scene.add(layer.group);
    }
  }

  const rendering = createRendering({
    camera,
    host,
    paper: materials,
    render: () => render(),
    renderer,
    scene,
  });
  rendering.configure(state.settings.rendering);
  weather.configure(state.settings);
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
  /** Each layer's last update on the CPU, for `describe`; measured in every session. */
  const updateMs = new Map<string, number>();
  /**
   * Draws one frame. The chart is still, so a frame is drawn only when a
   * repaint asks, and the next follows unasked only while a layer animates
   * and motion is not reduced. Under reduced motion the clock holds, so the
   * frames a pan draws leave the weather at the phase it stood at.
   */
  const drawMap = () => {
    camera.constrain();
    const view = camera.view();
    const time = tickClock(performance.now(), !reducedMotion.matches);
    reportRegionTerritory(view);
    state.visibility = detailVisibility(
      state.visibility,
      view.pixelsPerUnit,
      (state.responsibility?.composition?.marks.length ?? 0) > 0
    );
    for (const layer of sceneLayers) {
      if (layer.update) {
        const start = performance.now();
        timed(`layer:${layer.id}`, () => layer.update?.(view, state, time));
        updateMs.set(layer.id, performance.now() - start);
      }
      if (layer === labels) {
        // A label is hit before the land beneath it, so the island under
        // the pointer is known only once this frame's labels are placed;
        // the hover layer keys on it.
        state.hovered = hoverResolver?.(state.labels) ?? null;
      }
    }
    // CPU encode and submit only; GPU time is not measured.
    timed("render-submit", rendering.render);
    markLoad("spyglass:first-frame");
  };
  const frameRenderer = createFrameRenderer(drawMap, () =>
    sceneAnimating(sceneLayers, reducedMotion)
  );
  const render = frameRenderer.request;
  const resize = () => {
    camera.resize(state.selectedFile !== null);
    const { clientWidth, clientHeight } = host;
    renderer.setSize(clientWidth, clientHeight);
    render();
  };
  const observer = new ResizeObserver(resize);
  observer.observe(host);
  resize();
  // A change of the preference stills or starts the animated layers: one
  // frame shows the chart as it now stands, and the loop goes on from there
  // only if it may.
  const motionChanged = () => render();
  reducedMotion.addEventListener("change", motionChanged);
  const reveal = createBelongingReveal({ reducedMotion, render, state });
  const belongingNode = markNodes.find((node) => node.id === "belonging");
  let cancelWarm: (() => void) | null = null;
  /**
   * Applies a belonging layer once its marks are built: the frame that first
   * draws an island's districts used to pay about 35 ms to clip and drape
   * them, so the layer's node prepares them in idle time, from the state as
   * it will stand, and the reveal starts when they are ready. A layer
   * removed, or set while another prepares, takes effect at once.
   */
  const setBelonging = (value: AppliedState["belongingLayer"]) => {
    cancelWarm?.();
    cancelWarm = null;
    if (!(value && belongingNode?.prepare)) {
      reveal.set(value);
      return;
    }
    // A focused feature is the selection from this moment, as `reveal.set`
    // makes it; the file's focus must not linger while the layer prepares.
    if (value.featureFocus) {
      state.selectedFile = null;
    }
    const coming: ViewState = {
      ...state,
      belonging: value,
      belongingHover: null,
      belongingReveal: undefined,
    };
    cancelWarm = runIdle(belongingNode.prepare(camera.view(), coming), () => {
      cancelWarm = null;
      reveal.set(value);
      render();
    });
  };
  const markNodeSet = new Set<SceneLayer>(markNodes);
  const kindOf = (layer: SceneLayer): CompositionNode["kind"] => {
    if (layer === labels) {
      return "labels";
    }
    return markNodeSet.has(layer) ? "marks" : "layer";
  };
  /** The composition as one list: the layers in update order, each measured, then the pass graph's stages. */
  const describe = (): CompositionNode[] => [
    ...sceneLayers.map(
      (layer): CompositionNode => ({
        counts: layer.stats?.(),
        enabled: layer.group?.visible ?? true,
        id: layer.id,
        kind: kindOf(layer),
        updateMs: updateMs.get(layer.id) ?? null,
      })
    ),
    ...rendering.stages().map(
      (stage): CompositionNode => ({
        enabled: stage.enabled,
        id: stage.id,
        kind: "stage",
        updateMs: null,
      })
    ),
  ];
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
      configureWeather: weather.configure,
      data,
      focus,
      render,
      setBelonging,
      state,
    }),
    camera: { chartPoint: camera.chartPoint, view: camera.view },
    canvas: renderer.domElement,
    captureView: camera.captureView,
    data,
    describe,
    dispose() {
      cancelWarm?.();
      frameRenderer.dispose();
      reveal.dispose();
      observer.disconnect();
      reducedMotion.removeEventListener("change", motionChanged);
      camera.dispose();
      for (const layer of sceneLayers.toReversed()) {
        layer.dispose();
      }
      materials.dispose();
      rendering.dispose();
      renderer.dispose();
      renderer.domElement.remove();
    },
    focus,
    focusWreck,
    getRenderStatus: rendering.status,
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
    setLabelActivation: labels.setActivation,
    state,
    terrain: relief.geometries,
    zoom(factor) {
      camera.zoom(factor);
      render();
    },
  };
}
