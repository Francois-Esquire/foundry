import {
  AmbientLight,
  CanvasTexture,
  DirectionalLight,
  MathUtils,
  Mesh,
  MeshBasicMaterial,
  OrthographicCamera,
  Plane,
  PlaneGeometry,
  Raycaster,
  Scene,
  SRGBColorSpace,
  Vector2,
  Vector3,
} from "three";
import { MapControls } from "three/addons/controls/MapControls.js";
import { WebGPURenderer } from "three/webgpu";
import { paperThickness } from "../data/bindings";
import type {
  FormerPackage,
  SpyglassData,
  SpyglassFile,
  Territory,
} from "../data/types";
import { materials as lit } from "../ladder/ink-ladder";
import type { BelongingLayer, BelongingRegion } from "../layout/belonging";
import { hitBelonging, matchedRegion } from "../layout/belonging";
import { spyglassBoundaries } from "../layout/boundaries";
import { continentCoasts, createContinents } from "../layout/continent";
import type { DomainRef } from "../layout/domain-extent";
import {
  featureIdentity,
  hitNaturalFeature,
  type NaturalFeature,
} from "../layout/natural-feature-inspection";
import { islandAt } from "../layout/polygons";
import type { ResponsibilityOverlay } from "../layout/responsibility-focus";
import { createRoadNetwork } from "../layout/roads";
import { createSeaRipples } from "../layout/sea-ripples";
import { createTopography } from "../layout/topography";
import type { TradeRoute } from "../layout/trade-routes";
import { createTradeNavigation, leadingTrades } from "../layout/trade-routes";
import type { ChartSettings } from "../settings/chart-settings";
import { defaultChartSettings } from "../settings/chart-settings";
import { markLoad, type TimedStage, timeStage } from "../timings";
import {
  chartTilt,
  frameFiles,
  type InkView,
  inkView,
  keepSeaInFrame,
  zoomForPixels,
} from "../view/chart-view";
import {
  detailLevel,
  detailVisibility,
  fileInView,
} from "../view/detail-level";
import { hitComposition } from "./composition-hit";
import { createContinentGround } from "./continent-ground";
import type { MapLabel } from "./exploration";
import { labelUnder, visibleRegionTerritory } from "./exploration";
import { createFrameRenderer } from "./frame-render";
import {
  createHoverTarget,
  hoveredIsland,
  type PagePoint,
} from "./hover-target";
import { createInkTexture } from "./ink-texture";
import { createLabelProjector, createLettering } from "./lettering";
import { paintCoast, paintInk, paintSea } from "./paint-map";
import { createPaperMaterials } from "./paper-material";
import { createRenderPipeline } from "./pipeline";
import { createReliefLayer } from "./relief-layer";
import { createRoadLayer } from "./road-layer";
import { copySeaInk } from "./sea-ink";
import { createTradeLayer } from "./trade-layer";
import { createWaterMaterial } from "./water-material";
import { createWreckLayer } from "./wreck-layer";

export interface SpyglassSelection {
  compositeId?: string;
  feature?: NaturalFeature;
  file?: SpyglassFile;
  regionId?: string;
  symbol?: { id: string; name: string };
  territory: Territory;
  unmappedModule?: string;
}

/** Largest chart texture edge; every supported backend allows at least this. */
const maxTextureSize = 4096;

/** What a scene is built with, beside its host and data: read once when the scene is built. */
export interface SpyglassSceneOptions {
  coastalBuffer?: number;
  /** A developer session: the repaint stages and frame submits are timed (`timeStage`). */
  developer?: boolean;
  layers?: ChartSettings["layers"];
  onHover: (selection: SpyglassSelection | null) => void;
  /** The island whose regions the view frames, as the camera moves. */
  onRegionTerritory?: (territory: Territory | null) => void;
  onSelect: (selection: SpyglassSelection | null) => void;
  /** Opens chart settings from the painted compass; without it the compass is inert. */
  onSettings?: () => void;
  onTrades?: (routes: TradeRoute[]) => void;
  onWreck?: (wreck: FormerPackage | null, selected: boolean) => void;
}

export async function createSpyglassScene(
  host: HTMLElement,
  data: SpyglassData,
  options: SpyglassSceneOptions
) {
  const {
    coastalBuffer = 32,
    developer = false,
    layers = defaultChartSettings.layers,
    onHover,
    onRegionTerritory,
    onSelect,
    onSettings,
    onTrades,
    onWreck,
  } = options;
  const timed = <T>(stage: TimedStage, work: () => T): T =>
    timeStage(developer, stage, work);
  const renderer = new WebGPURenderer({
    alpha: true,
    antialias: true,
    trackTimestamp: true,
  });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.outputColorSpace = SRGBColorSpace;
  host.append(renderer.domElement);
  renderer.domElement.setAttribute(
    "aria-label",
    "Codebase spyglass. Drag to pan, scroll to zoom."
  );
  // WebGPU when the browser offers it, otherwise the WebGL 2 backend. Nothing
  // may render before the backend is ready.
  await renderer.init();
  const scene = new Scene();
  // Balanced so level paper renders at its own pigment: (1.23 + 3.16 × 0.6) / π ≈ 1.
  scene.add(new AmbientLight(lit.light.ambient, 1.23));
  const light = new DirectionalLight(lit.light.sun, 3.16);
  light.position.set(-600, 700, 700);
  scene.add(light);
  const camera = new OrthographicCamera(-1, 1, 1, -1, 1, 10_000);
  const tilt = chartTilt;
  camera.position.set(0, -Math.sin(tilt) * 2200, Math.cos(tilt) * 2200);
  camera.lookAt(0, 0, 0);
  const controls = new MapControls(camera, renderer.domElement);
  controls.enableRotate = false;
  controls.zoomToCursor = true;
  controls.screenSpacePanning = true;
  controls.enableDamping = false;
  controls.minZoom = 0.65;

  const canvas = document.createElement("canvas");
  const panRoom = 2.2;
  const seaData = {
    ...data,
    height: data.height * 1.65 * panRoom,
    width: data.width * 1.95 * panRoom,
  };
  const footprints = createContinents(data, coastalBuffer);
  const continents = layers.land ? footprints : [];
  const coasts = continentCoasts(data, continents);
  const topography = createTopography(data, coasts);
  const ripples = createSeaRipples(data, coasts);
  const boundaries = spyglassBoundaries(
    data,
    coastalBuffer,
    footprints.map((c) => c.field)
  );
  canvas.width = maxTextureSize;
  canvas.height = Math.round((canvas.width * seaData.height) / seaData.width);
  paintSea(canvas, seaData, continents);
  const texture = new CanvasTexture(canvas);
  texture.colorSpace = SRGBColorSpace;
  texture.anisotropy = renderer.getMaxAnisotropy();
  const paperCanvas = document.createElement("canvas");
  paperCanvas.width = maxTextureSize;
  paperCanvas.height = Math.round(
    (paperCanvas.width * data.height) / data.width
  );
  paintCoast(paperCanvas, data, continents);
  const paperTexture = new CanvasTexture(paperCanvas);
  paperTexture.colorSpace = SRGBColorSpace;
  paperTexture.anisotropy = texture.anisotropy;
  const coastMaterial = new MeshBasicMaterial({
    depthWrite: false,
    map: paperTexture,
    transparent: true,
  });
  const inkCanvas = document.createElement("canvas");
  inkCanvas.width = canvas.width;
  inkCanvas.height = canvas.height;
  paintInk(inkCanvas, { data });
  let inkTexture = createInkTexture(inkCanvas);
  const seaInkCanvas = document.createElement("canvas");
  let seaInkTexture = createInkTexture(seaInkCanvas);
  const inkMaterial = new MeshBasicMaterial({
    depthTest: false,
    depthWrite: false,
    map: seaInkTexture,
    transparent: true,
  });
  const ink = new Mesh(new PlaneGeometry(1, 1), inkMaterial);
  ink.position.z = paperThickness + 0.02;
  ink.renderOrder = 1;
  scene.add(ink);
  const materials = createPaperMaterials(paperTexture);
  const water = createWaterMaterial(texture, seaData);
  const sea = new Mesh(
    new PlaneGeometry(seaData.width, seaData.height),
    water.material
  );
  scene.add(sea);
  const coast = new Mesh(
    new PlaneGeometry(data.width, data.height),
    coastMaterial
  );
  coast.position.z = 0.01;
  scene.add(coast);
  const wreckLayer = createWreckLayer(data.formerPackages ?? []);
  scene.add(wreckLayer.group);

  const relief = createReliefLayer(data, materials.paper, inkTexture, tilt);
  scene.add(relief.group);
  markLoad("spyglass:terrain-built");
  const lettering = createLettering();
  scene.add(lettering.mesh);
  const projectLabel = createLabelProjector(relief.fieldFor, tilt);
  let selected: string | null = null;
  /**
   * The spyglass the ink reads: the one the scene was built from, until
   * `setData` brings its late readings; the geometry never changes.
   */
  let readings = data;
  let layoutTerritory: Territory | null = null;
  let drawingData = data;
  const roads = createRoadNetwork(data, layers.roads ? continents : []);
  const inland = (from: string, to: string) =>
    continents.some(
      (c) =>
        c.members.some((p) => p.id === from) &&
        c.members.some((p) => p.id === to)
    );
  const navigateSea = createTradeNavigation({
    ...data,
    routes: data.routes.filter((r) => !inland(r.from, r.to)),
  });
  const navigateTrades = (id?: string | null) => {
    const available = [...roads.routes, ...navigateSea(id)];
    return leadingTrades(data, id).flatMap(
      (r) =>
        available.find(
          (a) => a.dependency.from === r.from && a.dependency.to === r.to
        ) ?? []
    );
  };
  const roadLayer = createRoadLayer(roads);
  scene.add(roadLayer.group);
  let trades = navigateTrades();
  const tradeLayer = createTradeLayer(data);
  const ground = createContinentGround(data, continents, materials.paper);
  scene.add(ground.group);
  tradeLayer.setRoutes(
    trades.filter((r) => !inland(r.dependency.from, r.dependency.to))
  );
  scene.add(tradeLayer.group);
  onTrades?.(trades);
  let selectedFile: string | null = null;
  let responsibility: ResponsibilityOverlay | null = null;
  let belonging: BelongingLayer | null = null;
  let visibility = { composition: false, files: false };
  let matches: BelongingRegion | undefined;
  let showConnections = false;
  let legendHeight = 0;
  /** The declared domain the reader chose to draw; none at first. */
  let domain: DomainRef | null = null;
  let labels: MapLabel[] = [];
  let frame = 0;
  /** The resting pointer; each repaint inks the island under it (`paintHoverInk`). */
  const hoverTarget = createHoverTarget();
  let hoveredId: string | null = null;
  let settings = { ...defaultChartSettings };
  const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
  const motionChanged = () => {
    if (responsibility) {
      render();
    }
  };
  reducedMotion.addEventListener("change", motionChanged);
  const pipeline = createRenderPipeline({
    camera,
    onStatus: (status) => {
      host.dispatchEvent(
        new CustomEvent("spyglass:render", { detail: status })
      );
      // A stage finishes building after the frame that asked for it.
      render();
    },
    renderer,
    scene,
    unitsPerPixel: () =>
      (camera.right - camera.left) /
      (camera.zoom * Math.max(1, host.clientWidth)),
  });
  const applyRendering = () => {
    pipeline.configure(settings.rendering);
    const { rendering } = settings;
    materials.setOcclusion(
      rendering.quality !== "off" && rendering.ambientOcclusion
        ? rendering.aoIntensity
        : 0
    );
  };
  applyRendering();
  let reportedRegionTerritory: string | null = null;
  const constrainCamera = () =>
    keepSeaInFrame(
      camera,
      controls.target,
      tilt,
      seaData.width,
      seaData.height,
      Math.max(data.width, ((camera.right - camera.left) / camera.zoom) * 1.2),
      Math.max(
        data.height,
        ((camera.top - camera.bottom) / camera.zoom / Math.cos(tilt)) * 1.2
      ),
      panRoom
    );
  /** Draws one frame: the chart is still, so a frame is drawn only when a repaint asks. */
  const submitFrame = (pixelsPerUnit: number) => {
    water.setWreckReveal(pixelsPerUnit);
    // CPU encode and submit only; GPU time is not measured.
    timed("render-submit", () => pipeline.render());
    markLoad("spyglass:first-frame");
  };
  const drawMap = () => {
    constrainCamera();
    const view = inkView(
      camera,
      controls.target,
      tilt,
      paperThickness + 0.02,
      host.clientWidth
    );
    const regionTerritory =
      visibleRegionTerritory(drawingData.territories, view) ?? null;
    if (regionTerritory?.id !== reportedRegionTerritory) {
      reportedRegionTerritory = regionTerritory?.id ?? null;
      onRegionTerritory?.(regionTerritory);
    }
    const { x, y, width, height } = view;
    const tradeVisible = !(
      selectedFile ||
      belonging?.parents?.length ||
      responsibility
    );
    roadLayer.group.visible = tradeVisible && layers.roads;
    roadLayer.update(view.pixelsPerUnit);
    tradeLayer.group.visible = tradeVisible && settings.trade;
    visibility = detailVisibility(
      visibility,
      view.pixelsPerUnit,
      (responsibility?.composition?.marks.length ?? 0) > 0
    );
    ink.scale.set(width, height, 1);
    ink.position.set(x, -y, paperThickness + 0.02);
    labels = timed("ink", () =>
      paintInk(inkCanvas, {
        belonging,
        boundaries: { layers: boundaries, visible: settings.boundaries },
        data: drawingData,
        developer,
        domain,
        fileId: selectedFile,
        hovered: (placed) => {
          hoveredId = hoverTarget.island(
            (pointer) => hit(pointer, placed)?.territory.id
          );
          return hoveredIsland(hoveredId, drawingData.territories, selected);
        },
        legendHeight,
        lettering: { canvas: lettering.canvas, project: projectLabel },
        matches,
        responsibility: responsibility && {
          ...responsibility,
          reducedMotion: reducedMotion.matches,
        },
        ripples,
        selected,
        showConnections,
        streams: settings.streams,
        topography: settings.contours ? topography : [],
        view,
      })
    );
    timed("sea-ink", () =>
      copySeaInk(seaInkCanvas, inkCanvas, drawingData, view)
    );
    timed("relief", () => relief.setView(view));
    timed("lettering", () => lettering.update(view));
    seaInkTexture.needsUpdate = true;
    inkTexture.needsUpdate = true;
    submitFrame(view.pixelsPerUnit);
  };
  const frameRenderer = createFrameRenderer(drawMap);
  const render = frameRenderer.request;
  controls.addEventListener("change", frameRenderer.request);
  controls.addEventListener("start", () => {
    cancelAnimationFrame(frame);
  });
  let viewportWidth = 0;
  let overviewZoom = 1;
  const resize = () => {
    const previousPixels =
      (viewportWidth * camera.zoom) / (camera.right - camera.left);
    const width = host.clientWidth;
    const height = host.clientHeight;
    const aspect = width / Math.max(1, height);
    const span =
      Math.max(data.height * Math.cos(tilt), data.width / aspect) * 1.05;
    camera.left = (-span * aspect) / 2;
    camera.right = (span * aspect) / 2;
    camera.top = span / 2;
    camera.bottom = -span / 2;
    controls.maxZoom = zoomForPixels(camera, width, 24);
    if (selectedFile && viewportWidth > 0) {
      camera.zoom = zoomForPixels(camera, width, previousPixels);
    }
    controls.minZoom = constrainCamera();
    overviewZoom = Math.max(controls.minZoom, aspect < 0.8 ? 2.15 : 1.14);
    if (!viewportWidth) {
      camera.zoom = overviewZoom;
    }
    viewportWidth = width;
    camera.updateProjectionMatrix();
    renderer.setSize(width, height);
    inkCanvas.width = Math.min(
      maxTextureSize,
      Math.round(width * renderer.getPixelRatio())
    );
    inkCanvas.height = Math.min(
      maxTextureSize,
      Math.round(height * renderer.getPixelRatio())
    );
    inkTexture.dispose();
    inkTexture = createInkTexture(inkCanvas);
    relief.setMap(inkTexture);
    lettering.resize(inkCanvas.width, inkCanvas.height);
    seaInkCanvas.width = inkCanvas.width;
    seaInkCanvas.height = inkCanvas.height;
    seaInkTexture.dispose();
    seaInkTexture = createInkTexture(seaInkCanvas);
    inkMaterial.map = seaInkTexture;
    render();
  };
  const observer = new ResizeObserver(resize);
  observer.observe(host);
  resize();

  const raycaster = new Raycaster();
  const plane = new Plane(new Vector3(0, 0, 1), -paperThickness);
  const point = new Vector3();
  /** The place under a page point; `placed` are the labels to hit first, the last repaint's by default. */
  const hit = (
    event: PagePoint,
    placed: readonly MapLabel[] = labels
  ): SpyglassSelection | null =>
    resolveHit(
      renderer.domElement,
      raycaster,
      camera,
      plane,
      point,
      placed,
      controls,
      tilt,
      host,
      responsibility,
      drawingData,
      visibility,
      reducedMotion,
      belonging,
      settings.streams,
      relief.pick,
      event
    );
  let down = { x: 0, y: 0 };
  let previewTimer = 0;
  let previewFrame = 0;
  let revealFrame = 0;
  let previewKey = "";
  let selectedFeature: NaturalFeature | undefined;
  const preview = (selection: SpyglassSelection | null) => {
    onHover(selection);
    if (!belonging) {
      return;
    }
    cancelAnimationFrame(previewFrame);
    belonging = {
      ...belonging,
      emphasis: reducedMotion.matches ? 1 : 0,
      featureFocus: selection?.feature ?? selectedFeature,
      hovered: selection?.regionId ?? selection?.compositeId,
    };
    const start = performance.now();
    const animate = () => {
      if (!belonging) {
        return;
      }
      const progress = reducedMotion.matches
        ? 1
        : Math.min(1, (performance.now() - start) / 180);
      belonging = { ...belonging, emphasis: 1 - (1 - progress) ** 3 };
      render();
      if (progress < 1) {
        previewFrame = requestAnimationFrame(animate);
      }
    };
    animate();
  };
  const pointerDown = (e: PointerEvent) => {
    clearTimeout(previewTimer);
    down = { x: e.clientX, y: e.clientY };
  };
  const wreckAt = () => {
    const pixels =
      (host.clientWidth * camera.zoom) / (camera.right - camera.left);
    return (
      data.formerPackages?.find(
        (wreck) =>
          Math.hypot(point.x - wreck.x, -point.y - wreck.y) <
          Math.max(16, 12 / pixels)
      ) ?? null
    );
  };
  const pointerUp = (e: PointerEvent) => {
    if (Math.hypot(e.clientX - down.x, e.clientY - down.y) > 5) {
      return;
    }
    const selection = hit(e);
    const wreck = wreckAt();
    if (wreck) {
      onWreck?.(wreck, true);
      return;
    }
    if (
      onSettings &&
      Math.hypot(
        point.x - (data.width / 2 - 88),
        -point.y - (-data.height / 2 + 94)
      ) < 40
    ) {
      onSettings();
      return;
    }
    if (!(selection || selected)) {
      return;
    }
    onSelect(selection);
  };
  const pointerMove = (e: PointerEvent) => {
    // Kept while dragging too: a pan follows the pointer, so the island
    // under it stays the one inked.
    hoverTarget.move(e);
    if (e.buttons) {
      return;
    }
    const selection = hit(e);
    const wreck = wreckAt();
    onWreck?.(wreck, false);
    const compass =
      !!onSettings &&
      Math.hypot(
        point.x - (data.width / 2 - 88),
        -point.y - (-data.height / 2 + 94)
      ) < 40;
    renderer.domElement.style.cursor =
      selection || compass || wreck ? "pointer" : "grab";
    const key = selection
      ? `${selection.territory.id}:${selection.file?.id ?? (featureIdentity(selection.feature) || undefined) ?? selection.regionId ?? selection.compositeId ?? ""}`
      : "";
    if (key !== previewKey) {
      previewKey = key;
      clearTimeout(previewTimer);
      previewTimer = window.setTimeout(() => {
        preview(selection);
      }, 90);
    }
    if ((selection?.territory.id ?? null) !== hoveredId) {
      render();
    }
  };
  const pointerLeave = () => {
    clearTimeout(previewTimer);
    cancelAnimationFrame(previewFrame);
    previewKey = "";
    onHover(null);
    onWreck?.(null, false);
    if (belonging && (belonging.hovered || belonging.featureFocus)) {
      belonging = {
        ...belonging,
        featureFocus: selectedFeature,
        hovered: undefined,
      };
      render();
    }
    hoverTarget.leave();
    if (hoveredId) {
      render();
    }
  };
  renderer.domElement.addEventListener("pointerdown", pointerDown);
  renderer.domElement.addEventListener("pointerup", pointerUp);
  renderer.domElement.addEventListener("pointermove", pointerMove);
  renderer.domElement.addEventListener("pointerleave", pointerLeave);

  const focus = (
    initialTerritory: Territory | null,
    initialFile?: SpyglassFile,
    fileIds?: string[]
  ) => {
    let file = initialFile;
    let territory = initialTerritory;
    territory = territory
      ? (drawingData.territories.find((item) => item.id === territory?.id) ??
        territory)
      : null;
    file = file
      ? territory?.files.find((item) => item.id === file?.id)
      : undefined;
    selected = territory?.id ?? null;
    trades = navigateTrades(selected);
    tradeLayer.setRoutes(
      trades.filter((r) => !inland(r.dependency.from, r.dependency.to))
    );
    onTrades?.(trades);
    selectedFile = file?.id ?? null;
    const bounds = territory
      ? frameFiles(
          territory.files.filter((f) => !fileIds || fileIds.includes(f.id))
        )
      : null;
    const target = new Vector3(
      (territory?.x ?? 0) + (file?.x ?? bounds?.x ?? 0),
      -(territory?.y ?? 0) - (file?.y ?? bounds?.y ?? 0),
      0
    );
    const start = controls.target.clone();
    const offset = camera.position.clone().sub(controls.target);
    const zoomStart = camera.zoom;
    let zoom: number;
    zoom = focusEntries(
      file,
      camera,
      host,
      territory,
      fileIds,
      bounds,
      tilt,
      overviewZoom
    );
    const began = performance.now();
    const reduced = window.matchMedia(
      "(prefers-reduced-motion: reduce)"
    ).matches;
    cancelAnimationFrame(frame);
    const animate = () => {
      const t = reduced ? 1 : Math.min(1, (performance.now() - began) / 650);
      const ease = 1 - (1 - t) ** 4;
      controls.target.lerpVectors(start, target, ease);
      camera.position.copy(controls.target).add(offset);
      camera.zoom = zoomStart + (zoom - zoomStart) * ease;
      camera.updateProjectionMatrix();
      controls.update();
      render();
      if (t < 1) {
        frame = requestAnimationFrame(animate);
      }
    };
    animate();
  };
  return {
    captureView: () => ({
      pixels: (host.clientWidth * camera.zoom) / (camera.right - camera.left),
      x: controls.target.x,
      y: controls.target.y,
    }),
    configure: (next: ChartSettings) => {
      settings = { ...next };
      applyRendering();
      render();
    },
    dispose: () => {
      frameRenderer.dispose();
      clearTimeout(previewTimer);
      cancelAnimationFrame(previewFrame);
      cancelAnimationFrame(revealFrame);
      cancelAnimationFrame(frame);
      observer.disconnect();
      reducedMotion.removeEventListener("change", motionChanged);
      controls.dispose();
      renderer.domElement.removeEventListener("pointerdown", pointerDown);
      renderer.domElement.removeEventListener("pointerup", pointerUp);
      renderer.domElement.removeEventListener("pointermove", pointerMove);
      renderer.domElement.removeEventListener("pointerleave", pointerLeave);
      sea.geometry.dispose();
      coast.geometry.dispose();
      coastMaterial.dispose();
      relief.dispose();
      lettering.dispose();
      seaInkTexture.dispose();
      texture.dispose();
      paperTexture.dispose();
      ink.geometry.dispose();
      inkMaterial.dispose();
      inkTexture.dispose();
      materials.dispose();
      water.dispose();
      wreckLayer.dispose();
      tradeLayer.dispose();
      roadLayer.dispose();
      ground.dispose();
      pipeline.dispose();
      renderer.dispose();
      renderer.domElement.remove();
    },
    focus,
    focusWreck: (wreck: FormerPackage) => {
      const start = controls.target.clone();
      const target = new Vector3(wreck.x, -wreck.y, 0);
      const offset = camera.position.clone().sub(controls.target);
      const zoomStart = camera.zoom;
      const began = performance.now();
      const reduced = reducedMotion.matches;
      cancelAnimationFrame(frame);
      const animate = () => {
        const t = reduced ? 1 : Math.min(1, (performance.now() - began) / 650);
        const ease = 1 - (1 - t) ** 4;
        controls.target.lerpVectors(start, target, ease);
        camera.position.copy(controls.target).add(offset);
        camera.zoom = zoomStart + (8 - zoomStart) * ease;
        camera.updateProjectionMatrix();
        controls.update();
        render();
        if (t < 1) {
          frame = requestAnimationFrame(animate);
        }
      };
      animate();
    },
    getRenderStatus: pipeline.status,
    pinRegion: () => {
      selectedFile = null;
      render();
    },
    restoreView: (view: { x: number; y: number; pixels: number }) => {
      const offset = camera.position.clone().sub(controls.target);
      controls.target.set(view.x, view.y, 0);
      camera.position.copy(controls.target).add(offset);
      camera.zoom = MathUtils.clamp(
        zoomForPixels(camera, host.clientWidth, view.pixels),
        controls.minZoom,
        controls.maxZoom
      );
      camera.updateProjectionMatrix();
      controls.update();
      render();
    },
    setBelonging: (value: BelongingLayer | null) => {
      if (value?.featureFocus) {
        selectedFile = null;
      }
      selectedFeature = value?.featureFocus;
      clearTimeout(previewTimer);
      cancelAnimationFrame(previewFrame);
      cancelAnimationFrame(revealFrame);
      previewKey = "";
      const changed =
        belonging?.territory.id !== value?.territory.id ||
        belonging?.parents?.at(-1)?.id !== value?.parents?.at(-1)?.id ||
        (!belonging?.regions.length && !!value?.regions.length);
      belonging = value;
      if (belonging && changed && !reducedMotion.matches) {
        belonging = { ...belonging, reveal: 0 };
        const start = performance.now();
        const animate = () => {
          if (!belonging) {
            return;
          }
          const progress = Math.min(1, (performance.now() - start) / 240);
          belonging = { ...belonging, reveal: 1 - (1 - progress) ** 3 };
          render();
          if (progress < 1) {
            revealFrame = requestAnimationFrame(animate);
          }
        };
        animate();
      }
      render();
    },
    setConnections: (visible: boolean) => {
      showConnections = visible;
      render();
    },
    /**
     * The same spyglass with its late readings (`loadLateReadings`): the
     * islands and everything built from them stay; the ink repaints.
     */
    setData: (next: SpyglassData) => {
      readings = next;
      drawingData = resolveSetTerritoryLayout(layoutTerritory, readings);
      render();
    },
    setDomain: (chosen: DomainRef | null) => {
      domain = chosen;
      render();
    },
    setLegendHeight: (height: number) => {
      legendHeight = height;
      render();
    },
    setResponsibility: (value: ResponsibilityOverlay | null) => {
      responsibility = value;
      const territory = drawingData.territories.find(
        (item) => item.id === value?.territoryId
      );
      matches =
        value && territory ? matchedRegion(territory, value) : undefined;
      render();
    },
    setTerritoryLayout: (territory: Territory | null) => {
      layoutTerritory = territory;
      drawingData = resolveSetTerritoryLayout(territory, readings);
      const current =
        data.territories.find((item) => item.id === selected) ?? null;
      focus(
        current,
        current?.files.find((item) => item.id === selectedFile)
      );
    },
    zoom: (factor: number) => {
      cancelAnimationFrame(frame);
      camera.zoom = MathUtils.clamp(
        camera.zoom * factor,
        controls.minZoom,
        controls.maxZoom
      );
      camera.updateProjectionMatrix();
      render();
    },
  };
}

function resolveSetTerritoryLayout(
  territory: Territory | null,
  data: SpyglassData
): SpyglassData {
  if (territory) {
    return {
      ...data,
      territories: data.territories.map((item) =>
        item.id === territory.id ? territory : item
      ),
    };
  }
  return data;
}

function hitTerritory(
  drawingData: SpyglassData,
  point: Vector3,
  initialDistance: number,
  initialClosest: SpyglassSelection | null,
  visibility: { composition: boolean; files: boolean },
  pixels: number
) {
  let closest = initialClosest;
  let distance = initialDistance;
  for (const territory of drawingData.territories) {
    const x = point.x - territory.x;
    const y = -point.y - territory.y;
    for (const file of territory.files) {
      const d = Math.hypot(file.x - x, file.y - y);
      if (d < distance && d < 20) {
        distance = d;
        closest = {
          territory,
          ...(visibility.files && d < Math.max(1, 5 / pixels) ? { file } : {}),
        };
      }
    }
  }
  return { closest, distance };
}

function focusEntries(
  file: SpyglassFile | undefined,
  camera: OrthographicCamera,
  host: HTMLElement,
  territory: Territory | null,
  fileIds: string[] | undefined,
  bounds: { height: number; width: number; x: number; y: number } | null,
  tilt: number,
  overviewZoom: number
): number {
  let zoom: number;
  if (file) {
    zoom = zoomForPixels(camera, host.clientWidth, 10);
  } else if (territory && !fileIds) {
    zoom = zoomForPixels(camera, host.clientWidth, 2.2);
  } else if (bounds) {
    zoom = Math.min(
      12,
      (camera.right - camera.left) / (bounds.width * 1.4),
      (camera.top - camera.bottom) / (bounds.height * Math.cos(tilt) * 1.4)
    );
  } else if (territory) {
    zoom = zoomForPixels(camera, host.clientWidth, 2.2);
  } else {
    zoom = overviewZoom;
  }
  return zoom;
}
function resolveHit(
  canvas: HTMLCanvasElement,
  raycaster: Raycaster,
  camera: OrthographicCamera,
  plane: Plane,
  point: Vector3,
  labels: readonly MapLabel[],
  controls: MapControls,
  tilt: 0.7,
  host: HTMLElement,
  responsibility: ResponsibilityOverlay | null,
  drawingData: SpyglassData,
  visibility: { composition: boolean; files: boolean },
  reducedMotion: MediaQueryList,
  belonging: BelongingLayer | null,
  streams: boolean,
  pickTerrain: (point: Vector3) => Vector3 | undefined,
  event: PagePoint
): SpyglassSelection | null {
  const rect = canvas.getBoundingClientRect();
  raycaster.setFromCamera(
    new Vector2(
      ((event.clientX - rect.left) / rect.width) * 2 - 1,
      (-(event.clientY - rect.top) / rect.height) * 2 + 1
    ),
    camera
  );
  if (!raycaster.ray.intersectPlane(plane, point)) {
    return null;
  }
  const label = labelUnder(labels, point.x, -point.y);
  if (label?.territory) {
    return {
      compositeId: label.compositeId,
      file: label.file,
      regionId: label.regionId,
      territory: label.territory,
    };
  }
  const surface = pickTerrain(point);
  if (surface) {
    point.copy(surface);
  }
  const view = inkView(
    camera,
    controls.target,
    tilt,
    paperThickness + 0.02,
    host.clientWidth
  );
  let overlay = responsibility;
  overlay = resolveHitEntries(overlay, drawingData, view);
  if (overlay && visibility.composition) {
    const compositionHit = hitVisibleComposition(
      overlay,
      drawingData,
      point,
      reducedMotion.matches,
      (host.clientWidth * camera.zoom) / (camera.right - camera.left)
    );
    if (compositionHit) {
      return compositionHit;
    }
  }
  let closest: SpyglassSelection | null = null;
  const pixels =
    (host.clientWidth * camera.zoom) / (camera.right - camera.left);
  const level = detailLevel(
    pixels,
    (overlay?.composition?.marks.length ?? 0) > 0
  );
  let distance = Number.POSITIVE_INFINITY;
  ({ distance, closest } = hitTerritory(
    drawingData,
    point,
    distance,
    closest,
    visibility,
    pixels
  ));
  const land = islandAt({ x: point.x, y: -point.y }, drawingData.territories);
  if (
    belonging &&
    land?.id === belonging.territory.id &&
    !closest?.file &&
    level.composition < 0.5
  ) {
    const internal = hitInternalPlace(
      belonging,
      { x: point.x - land.x, y: -point.y - land.y },
      pixels,
      streams
    );
    if (internal) {
      return internal;
    }
  }
  if (belonging && land?.id === belonging.territory.id && !closest?.file) {
    return {
      compositeId: belonging.parents?.find((parent) => parent.children)?.id,
      regionId: belonging.parents?.find((parent) => !parent.children)?.id,
      territory: land,
    };
  }
  if (land) {
    if (closest?.territory.id === land.id) {
      return closest;
    }
    return { territory: land };
  }
  return null;
}

function resolveHitEntries(
  initialOverlay: ResponsibilityOverlay | null,
  drawingData: SpyglassData,
  view: InkView
) {
  let overlay = initialOverlay;
  if (
    overlay?.composition &&
    !fileInView(
      drawingData.territories.find((item) => item.id === overlay?.territoryId),
      overlay.composition.fileId,
      view
    )
  ) {
    overlay = { ...overlay, composition: undefined, trace: undefined };
  }
  return overlay;
}
function hitVisibleComposition(
  overlay: ResponsibilityOverlay,
  drawingData: SpyglassData,
  point: Vector3,
  reducedMotion: boolean,
  pixels: number
): SpyglassSelection | null {
  const territory = drawingData.territories.find(
    (item) => item.id === overlay.territoryId
  );
  if (territory) {
    const detail = hitComposition(
      territory,
      { ...overlay, reducedMotion },
      point.x - territory.x,
      -point.y - territory.y,
      pixels
    );
    if (detail) {
      return { territory, ...detail };
    }
  }
  return null;
}

function hitInternalPlace(
  belonging: BelongingLayer,
  point: { x: number; y: number },
  pixels: number,
  streams: boolean
): SpyglassSelection | undefined {
  const { territory, features } = belonging;
  const feature =
    features && hitNaturalFeature(features, point, pixels, streams);
  if (feature) {
    return { feature, territory };
  }
  const region = hitBelonging(belonging, point.x, point.y, pixels);
  if (region) {
    return region.children
      ? { compositeId: region.id, territory }
      : { regionId: region.id, territory };
  }
}
