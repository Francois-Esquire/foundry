import type { SpyglassData } from "../data/types";
import { surveyChart } from "../layout/survey";
import { createTradeChart } from "../layout/trade-chart";
import { visibleRegionTerritory } from "../layout/visible-territory";
import { defaultChartSettings } from "../settings/chart-settings";
import {
  isSceneLayerVisible,
  sceneLayerDefinitions,
} from "../settings/scene-composition";
import { markLoad, type TimedStage, timeStage } from "../timings";
import type { InkView } from "../view/chart-view";
import { detailVisibility } from "../view/detail-level";
import { createApply } from "./apply-changes";
import type { AppliedState } from "./apply-plan";
import { createArchitectureLayer } from "./architecture-layer";
import { createBelongingReveal } from "./belonging-reveal";
import { createChartCamera } from "./chart-camera";
import { createClock } from "./clock";
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
import { createLayerComposition } from "./layer-composition";
import { markLayers } from "./marks/layers";
import { type MarkChart, markLayerNode } from "./marks/mark-layer";
import { createPaperMaterials } from "./paper-material";
import { createReliefLayer } from "./relief-layer";
import { createLitScene, openRenderer } from "./renderer";
import { createRendering } from "./rendering";
import { createRoadLayer } from "./road-layer";
import { createSeaLayer } from "./sea-layer";
import { createTradeLayer } from "./trade-layer";
import { createViewState, resolveShown, type ViewState } from "./view-state";
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
 * renderer, the camera, the mesh and mark layers, the injected label layer over the
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
  // The scene's clock and material effects: the sea and paper read them.
  const state = createViewState(data, defaultChartSettings);
  const visible = (id: Parameters<typeof isSceneLayerVisible>[1]) =>
    isSceneLayerVisible(state.settings.composition, id);
  const clock = createClock();
  const weatherConsumers = () => ({
    paper: visible("relief") || (visible("ground") && layers.land),
    sea: visible("sea"),
  });
  const weather = createWeatherLayer(clock, weatherConsumers);
  const sea = createSeaLayer({
    chart: data,
    coasts: chart.coasts,
    sea: seaData,
    shore: chart.shore,
    weather,
  });
  const materials = createPaperMaterials(weather);
  const relief = createReliefLayer(data, materials.paper);
  const architecture = createArchitectureLayer(data, relief.islandOf);
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
      reliefOf: relief.islandOf,
    })
  );
  const camera = createChartCamera({
    canvas: renderer.domElement,
    data,
    host,
    onChange: () => render(),
    reducedMotion,
    sea: { height: seaData.height, panRoom, width: seaData.width },
  });
  const labels = options.labels({
    camera: camera.camera,
    fileHeight: (fileId, view, drawingData) =>
      visible("architecture")
        ? architecture.roofHeight(fileId, view, drawingData)
        : undefined,
    pixelRatio: () => renderer.getPixelRatio(),
    publish: (placed) => {
      state.labels = placed;
    },
    reliefOf: relief.islandOf,
  });
  let hoverResolver: HoverResolver | null = null;
  /**
   * The chart's layers in the order they update: the labels first, since
   * their update places the frame's labels on the state, then the step
   * that resolves the island under the pointer from them, since a label
   * is hit before the land beneath it and the hover layer keys on the
   * answer; then the drawn layers, bottom to top of the z-order. The
   * labels are elements over the canvas, so their place in this list is
   * not their depth: they lie over everything. The weather draws nothing
   * itself: the sea and the paper read its uniforms, and it is the layer
   * that animates.
   */
  const sceneLayers: SceneLayer[] = [
    {
      dispose: () => undefined,
      id: "annotations",
      kind: "layer",
      update: labels.updateAnnotations,
    },
    labels,
    {
      dispose: () => undefined,
      id: "hover-resolve",
      kind: "layer",
      update: () => {
        state.hovered = hoverResolver?.() ?? null;
      },
    },
    sea,
    architecture,
    { ...weather, enabled: () => weather.animating?.() ?? false },
    ...markNodes,
    {
      dispose: wrecks.dispose,
      group: wrecks.group,
      id: "wrecks",
      kind: "layer",
    },
    {
      dispose: relief.dispose,
      group: relief.group,
      id: "relief",
      kind: "layer",
    },
    {
      dispose: () => undefined,
      group: relief.cliffs,
      id: "cliffs",
      kind: "layer",
    },
    {
      dispose: roads.dispose,
      enabled: (current) => tradesVisible(current) && layers.roads,
      group: roads.group,
      id: "roads",
      kind: "layer",
      update: (view) => roads.update(view.pixelsPerUnit),
    },
    {
      dispose: tradeLayer.dispose,
      enabled: (current) => tradesVisible(current) && current.settings.trade,
      group: tradeLayer.group,
      id: "trades",
      kind: "layer",
    },
    {
      dispose: ground.dispose,
      enabled: () => layers.land,
      group: ground.group,
      id: "ground",
      kind: "layer",
    },
  ];
  for (const layer of sceneLayers) {
    if (layer.group) {
      scene.add(layer.group);
    }
  }

  const composition = createLayerComposition(sceneLayers);
  composition.sync(state);

  const rendering = createRendering({
    camera,
    host,
    paper: materials,
    render: () => render(),
    renderer,
    scene,
    selectedObjects: () =>
      state.selected && visible("selection")
        ? relief.meshesOf(state.selected)
        : [],
  });
  rendering.configure(state.settings.rendering);
  weather.configure(state.settings);
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
   * frames a pan draws leave the weather at the phase it stood at. The
   * belonging layer and the overlay are resolved against the view once,
   * first: the detail visibility and every layer read the one answer.
   */
  const drawMap = () => {
    camera.constrain();
    const view = camera.view();
    reportRegionTerritory(view);
    state.shown = resolveShown(state, view);
    state.visibility = detailVisibility(
      state.visibility,
      view.pixelsPerUnit,
      state.shown.hasComposition
    );
    composition.sync(state);
    const time = clock.tick(
      performance.now(),
      sceneAnimating(sceneLayers, reducedMotion, composition.enabled)
    );
    composition.update(view, state, time, (layer, update) => {
      const start = performance.now();
      timed(`layer:${layer.id}`, update);
      updateMs.set(layer.id, performance.now() - start);
    });
    // CPU encode and submit only; GPU time is not measured.
    timed("render-submit", rendering.render);
    markLoad("spyglass:first-frame");
  };
  const frameRenderer = createFrameRenderer(drawMap, () =>
    sceneAnimating(sceneLayers, reducedMotion, composition.enabled)
  );
  const render = frameRenderer.request;
  const resize = () => {
    camera.resize();
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
  const reveal = createBelongingReveal({
    reducedMotion,
    render,
    state,
    visible: () => visible("belonging"),
  });
  const belongingNode = markNodes.find((node) => node.id === "belonging");
  let cancelWarm: (() => void) | null = null;
  let pendingBelonging: AppliedState["belongingLayer"] = null;
  const configureComposition = () => {
    composition.sync(state);
    if (!visible("belonging")) {
      if (cancelWarm) {
        cancelWarm();
        cancelWarm = null;
        reveal.set(pendingBelonging);
        pendingBelonging = null;
      }
      reveal.finish();
    }
  };
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
    pendingBelonging = null;
    if (!(value && belongingNode?.prepare && visible("belonging"))) {
      reveal.set(value);
      return;
    }
    // A focused feature is the selection from this moment, as `reveal.set`
    // makes it; the file's focus must not linger while the layer prepares.
    if (value.featureFocus) {
      state.selectedFile = null;
    }
    const view = camera.view();
    const applied = {
      ...state,
      belonging: value,
      belongingHover: null,
      belongingReveal: undefined,
    };
    const coming: ViewState = {
      ...applied,
      shown: resolveShown(applied, view),
    };
    pendingBelonging = value;
    cancelWarm = runIdle(belongingNode.prepare(view, coming), () => {
      cancelWarm = null;
      pendingBelonging = null;
      reveal.set(value);
      render();
    });
  };
  /** The composition as one list: the layers in update order, each measured, then the pass graph's stages. */
  const describe = (): CompositionNode[] => [
    ...sceneLayers
      .filter((layer) => layer.id !== "annotations")
      .map(
        (layer): CompositionNode => ({
          counts: layer.stats?.(),
          enabled: composition.enabled(layer),
          id: layer.id,
          kind: layer.kind,
          updateMs: composition.enabled(layer)
            ? (updateMs.get(layer.id) ?? null)
            : null,
        })
      ),
    ...sceneLayerDefinitions
      .filter(
        ({ category, id }) => category === "Annotations" && id !== "labels"
      )
      .map(
        ({ id }): CompositionNode => ({
          enabled: visible(id),
          id,
          kind: "labels",
          updateMs: null,
        })
      ),
    ...sceneLayerDefinitions
      .filter(({ category }) => category === "Effects")
      .map(({ id }): CompositionNode => {
        const consumers = weatherConsumers();
        let enabled = visible(id) && consumers.sea;
        if (id === "subsurface-drift") {
          enabled =
            weather.drawn.drift.value > 0 && (consumers.sea || consumers.paper);
        } else if (id === "surface-motion") {
          enabled = weather.drawn.surface.value > 0 && consumers.sea;
        } else if (id === "rim-surf") {
          enabled = weather.drawn.surf.value > 0 && consumers.sea;
        }
        return { enabled, id, kind: "layer", updateMs: null };
      }),
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
    onTrades,
    state,
    trade,
    tradeLayer,
  });
  return {
    apply: createApply({
      configureComposition,
      configurePresentation: camera.setPresentation,
      configureRendering: rendering.configure,
      configureWeather: weather.configure,
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
      clock.dispose();
      const settled = rendering.settled();
      rendering.dispose();
      renderer.domElement.remove();
      // A frame's timestamp query may still be resolving; disposing the
      // renderer under it aborts the query and logs an error on every rebuild.
      settled.then(() => renderer.dispose());
    },
    focus,
    focusWreck,
    getRenderStatus: rendering.status,
    pickBuilding: (point) =>
      visible("architecture") ? architecture.pick(point, camera.view()) : null,
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
