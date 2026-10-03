import type { Object3DEventMap } from "three";
import {
  AmbientLight,
  CanvasTexture,
  DirectionalLight,
  type Group,
  MathUtils,
  Mesh,
  MeshBasicMaterial,
  OrthographicCamera,
  PCFSoftShadowMap,
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
import type { MapPoint } from "../atmosphere";
import {
  atmosphereStrength,
  clearWind,
  islandAt,
  windPath,
} from "../atmosphere";
import type { BelongingLayer, BelongingRegion } from "../belonging";
import { hitBelonging, matchedRegion } from "../belonging";
import type { ChartSettings } from "../chart-settings";
import { defaultChartSettings } from "../chart-settings";
import { continentCoasts, createContinents } from "../continent";
import {
  featureIdentity,
  hitNaturalFeature,
  type NaturalFeature,
} from "../natural-feature-inspection";
import type { ResponsibilityOverlay } from "../responsibility-focus";
import { createRoadNetwork } from "../roads";
import type { TradeRoute } from "../trade-routes";
import { createTradeNavigation, leadingTrades } from "../trade-routes";
import type { AtlasData, AtlasFile, FormerPackage, Territory } from "../types";
import { createAtmosphereLayer } from "./atmosphere-layer";
import { atlasBoundaries, paintBoundaries } from "./boundaries";
import { hitComposition } from "./composition-hit";
import { detailLevel, detailVisibility, fileInView } from "./detail-level";
import { createEcosystemLayer } from "./ecosystem-layer";
import type { InkView, MapLabel } from "./exploration";
import {
  frameFiles,
  inkView,
  keepSeaInFrame,
  visibleRegionTerritory,
  zoomForPixels,
} from "./exploration";
import { createFrameRenderer } from "./frame-render";
import { createInkTexture } from "./ink-texture";
import { createLabelProjector, createLettering } from "./lettering";
import { paintMap } from "./paint-map";
import { createPaperMaterials, paperThickness } from "./paper-material";
import { createRenderPipeline } from "./pipeline";
import type { PlaybackSnapshot, TrackId } from "./playback";
import { createPlayback } from "./playback";
import { createReliefLayer } from "./relief-layer";
import { createRoadLayer } from "./road-layer";
import { copySeaInk } from "./sea-ink";
import { createTopography } from "./topography";
import { createTradeLayer } from "./trade-layer";
import { createWaterMaterial } from "./water-material";
import { createWreckLayer } from "./wreck-layer";

export interface AtlasSelection {
  compositeId?: string;
  feature?: NaturalFeature;
  file?: AtlasFile;
  neighborhoodId?: string;
  regionId?: string;
  symbol?: { id: string; name: string };
  territory: Territory;
  unmappedModule?: string;
}

/** Largest chart texture edge; every supported backend allows at least this. */
const maxTextureSize = 4096;

export async function createAtlasScene(
  host: HTMLElement,
  data: AtlasData,
  onSelect: (selection: AtlasSelection | null) => void,
  onHover: (selection: AtlasSelection | null) => void,
  onSettings?: () => void,
  onTrades?: (routes: TradeRoute[]) => void,
  coastalBuffer = 32,
  layers = defaultChartSettings.layers,
  onWreck?: (wreck: FormerPackage | null, selected: boolean) => void,
  onRegionTerritory?: (territory: Territory | null) => void
) {
  const renderer = new WebGPURenderer({
    alpha: true,
    antialias: true,
    trackTimestamp: true,
  });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.outputColorSpace = SRGBColorSpace;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = PCFSoftShadowMap;
  host.append(renderer.domElement);
  renderer.domElement.setAttribute(
    "aria-label",
    "Codebase atlas. Drag to pan, scroll to zoom."
  );
  // WebGPU when the browser offers it, otherwise the WebGL 2 backend. Nothing
  // may render before the backend is ready.
  await renderer.init();
  const scene = new Scene();
  scene.add(new AmbientLight("#ffffff", 1.05));
  const light = new DirectionalLight("#fffaf4", 2.7);
  light.position.set(-600, 700, 700);
  light.castShadow = true;
  light.shadow.mapSize.set(2048, 2048);
  const shadowSpan = Math.max(data.width, data.height) * 0.75;
  light.shadow.camera.bottom = -shadowSpan;
  light.shadow.camera.left = light.shadow.camera.bottom;
  light.shadow.camera.top = shadowSpan;
  light.shadow.camera.right = light.shadow.camera.top;
  light.shadow.camera.near = 1;
  light.shadow.camera.far = 4000;
  light.shadow.bias = -0.0001;
  light.shadow.normalBias = 0.3;
  // Shadows only re-render when the props change, not on every frame.
  light.shadow.autoUpdate = false;
  light.shadow.needsUpdate = true;
  scene.add(light);
  const camera = new OrthographicCamera(-1, 1, 1, -1, 1, 10_000);
  const tilt = 0.7;
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
  const boundaries = atlasBoundaries(
    data,
    coastalBuffer,
    footprints.map((c) => c.field)
  );
  canvas.width = maxTextureSize;
  canvas.height = Math.round((canvas.width * seaData.height) / seaData.width);
  paintMap(
    canvas,
    seaData,
    null,
    null,
    "sea",
    undefined,
    undefined,
    [],
    null,
    false,
    null,
    undefined,
    continents
  );
  const texture = new CanvasTexture(canvas);
  texture.colorSpace = SRGBColorSpace;
  texture.anisotropy = renderer.getMaxAnisotropy();
  const paperCanvas = document.createElement("canvas");
  paperCanvas.width = maxTextureSize;
  paperCanvas.height = Math.round(
    (paperCanvas.width * data.height) / data.width
  );
  paintMap(
    paperCanvas,
    data,
    null,
    null,
    "coast",
    undefined,
    undefined,
    [],
    null,
    false,
    null,
    undefined,
    continents
  );
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
  paintMap(inkCanvas, data, null, null, "ink");
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
  const water = createWaterMaterial(texture, seaData, coasts);
  const ground = new Mesh(
    new PlaneGeometry(seaData.width, seaData.height),
    water.material
  );
  ground.receiveShadow = true;
  scene.add(ground);
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
  const reliefInk = relief.reliefInk();
  const lettering = createLettering();
  scene.add(lettering.mesh);
  const projectLabel = createLabelProjector(relief.fieldFor, tilt);
  let selected: string | null = null;
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
  const tradeLayer = createTradeLayer(
    data,
    new Set(
      layers.houses
        ? continents.flatMap((c) => c.members.map((p) => p.id))
        : data.territories.map((p) => p.id)
    )
  );
  const ecosystem = createEcosystemLayer(
    data,
    continents,
    materials.paper,
    roads.paths,
    layers
  );
  scene.add(ecosystem.group);
  tradeLayer.setRoutes(
    trades.filter((r) => !inland(r.dependency.from, r.dependency.to))
  );
  scene.add(tradeLayer.group);
  onTrades?.(trades);
  let selectedFile: string | null = null;
  let selectedNeighborhood: string | undefined;
  let responsibility: ResponsibilityOverlay | null = null;
  let belonging: BelongingLayer | null = null;
  let visibility = { composition: false, files: false };
  let matches: BelongingRegion | undefined;
  let showConnections = false;
  let labels: MapLabel[] = [];
  let frame = 0;
  let focusedTerritory: Territory | null = null;
  const projectAtmosphere = ({ x, y }: { x: number; y: number }) => {
    const p = new Vector3(x, -y, paperThickness + 0.04).project(camera);
    return {
      x: ((p.x + 1) * host.clientWidth) / 2,
      y: ((1 - p.y) * host.clientHeight) / 2,
    };
  };
  const currentStrength = () =>
    atmosphereStrength(
      (host.clientWidth * camera.zoom) / (camera.right - camera.left)
    );
  let settings = { ...defaultChartSettings };
  const playback = createPlayback();
  const playbackMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
  const pauseForReducedMotion = () => {
    if (playbackMotion.matches) {
      playback.play(false);
    }
    if (responsibility) {
      render();
    }
  };
  pauseForReducedMotion();
  playbackMotion.addEventListener("change", pauseForReducedMotion);
  let waveTimer = 0;
  const atmosphere = createAtmosphereLayer(host, projectAtmosphere, {
    running: playback.running,
    strength: currentStrength,
    update: (time, enabled) => {
      playback.tick(time);
      water.update(playback.snapshot(), enabled ? currentStrength() : 0);
      water.setWreckReveal(
        (host.clientWidth * camera.zoom) / (camera.right - camera.left)
      );
      pipeline.render();
    },
  });
  const pipeline = createRenderPipeline({
    camera,
    filter: () => settings.filter,
    onStatus: (status) => {
      atmosphere.setComposited(status.postProcessing);
      host.dispatchEvent(new CustomEvent("atlas:render", { detail: status }));
      // A stage finishes building after the frame that asked for it.
      render();
    },
    overlay: atmosphere.texture,
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
  const seekCurrent = (milliseconds: number | null) => {
    if (
      milliseconds !== null &&
      (!Number.isFinite(milliseconds) || milliseconds < 0)
    ) {
      return;
    }
    playback.play(milliseconds === null);
    if (milliseconds !== null) {
      playback.seek(milliseconds / 1000);
    }
    atmosphere.setCurrentTime(milliseconds);
  };
  const setCurrentTime = (event: Event) => {
    const time: unknown = (event as CustomEvent<unknown>).detail;
    if (time === null || typeof time === "number") {
      seekCurrent(time);
    }
  };
  host.addEventListener("atlas:current-time", setCurrentTime);
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
    if (
      ecosystem.update(
        view.pixelsPerUnit,
        Boolean(selectedFile) ||
          Boolean(selectedNeighborhood) ||
          Boolean(belonging?.parents?.length) ||
          Boolean(responsibility)
      )
    ) {
      light.shadow.needsUpdate = true;
    }
    const tradeVisible = !(
      selectedFile ||
      selectedNeighborhood ||
      belonging?.parents?.length ||
      responsibility
    );
    roadLayer.group.visible = tradeVisible && layers.roads;
    roadLayer.update(view.pixelsPerUnit);
    if (tradeLayer.group.visible !== (tradeVisible && layers.trade)) {
      tradeLayer.group.visible = tradeVisible && layers.trade;
      light.shadow.needsUpdate = true;
    }
    visibility = detailVisibility(
      visibility,
      view.pixelsPerUnit,
      (responsibility?.composition?.marks.length ?? 0) > 0
    );
    ink.scale.set(width, height, 1);
    ink.position.set(x, -y, paperThickness + 0.02);
    labels = paintMap(
      inkCanvas,
      drawingData,
      selected,
      selectedFile,
      "ink",
      view,
      selectedNeighborhood,
      settings.contours ? topography : [],
      responsibility && {
        ...responsibility,
        reducedMotion: playbackMotion.matches,
      },
      showConnections,
      belonging,
      matches,
      [],
      settings.streams,
      reliefInk,
      { canvas: lettering.canvas, project: projectLabel }
    );
    const inkContext = inkCanvas.getContext("2d");
    if (inkContext) {
      paintBoundaries(
        inkContext,
        boundaries,
        settings.boundaries,
        view.pixelsPerUnit
      );
    }
    copySeaInk(seaInkCanvas, inkCanvas, drawingData, view);
    relief.setView(view);
    lettering.update(view);
    seaInkTexture.needsUpdate = true;
    inkTexture.needsUpdate = true;
    atmosphere.cameraChanged();
  };
  const frameRenderer = createFrameRenderer(drawMap);
  const render = frameRenderer.request;
  controls.addEventListener("change", frameRenderer.request);
  controls.addEventListener("start", () => {
    cancelAnimationFrame(frame);
    atmosphere.wind(null);
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
  const hit = (event: PointerEvent): AtlasSelection | null =>
    resolveHit(
      renderer.domElement,
      raycaster,
      camera,
      plane,
      point,
      labels,
      tradeLayer,
      controls,
      tilt,
      host,
      responsibility,
      drawingData,
      visibility,
      playbackMotion,
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
  const preview = (selection: AtlasSelection | null) => {
    onHover(selection);
    if (!belonging) {
      return;
    }
    cancelAnimationFrame(previewFrame);
    belonging = {
      ...belonging,
      emphasis: playbackMotion.matches ? 1 : 0,
      featureFocus: selection?.feature ?? selectedFeature,
      hovered: selection?.regionId ?? selection?.compositeId,
    };
    const start = performance.now();
    const animate = () => {
      if (!belonging) {
        return;
      }
      const progress = playbackMotion.matches
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
    atmosphere.highlight(selection?.territory ?? focusedTerritory);
    const origin = { x: point.x, y: -point.y };
    atmosphere.wind(
      resolvePointerMove(
        selection,
        selectedFile,
        host,
        camera,
        origin,
        data,
        labels
      )
    );
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
    atmosphere.highlight(focusedTerritory);
    atmosphere.wind(null);
  };
  renderer.domElement.addEventListener("pointerdown", pointerDown);
  renderer.domElement.addEventListener("pointerup", pointerUp);
  renderer.domElement.addEventListener("pointermove", pointerMove);
  renderer.domElement.addEventListener("pointerleave", pointerLeave);

  const focus = (
    initialTerritory: Territory | null,
    initialFile?: AtlasFile,
    neighborhoodId?: string,
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
    light.shadow.needsUpdate = true;
    onTrades?.(trades);
    focusedTerritory = territory;
    atmosphere.highlight(territory);
    selectedFile = file?.id ?? null;
    selectedNeighborhood =
      territory?.neighborhoods.find((group) => group.id === neighborhoodId)
        ?.id ??
      territory?.neighborhoods.find(
        (group) => file && group.members.includes(file.id)
      )?.id;
    paintMap(
      paperCanvas,
      data,
      selected,
      file?.id ?? null,
      "coast",
      undefined,
      undefined,
      [],
      null,
      false,
      null,
      undefined,
      continents
    );
    paperTexture.needsUpdate = true;
    const members =
      fileIds ??
      territory?.neighborhoods.find((n) => n.id === selectedNeighborhood)
        ?.members;
    const bounds = territory
      ? frameFiles(
          territory.files.filter((f) => !members || members.includes(f.id))
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
      neighborhoodId,
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
      const directionChanged = next.windDirection !== settings.windDirection;
      const contoursChanged =
        next.contours !== settings.contours ||
        next.boundaries !== settings.boundaries ||
        next.streams !== settings.streams;
      settings = { ...next };
      water.configure(settings);
      applyRendering();
      if (directionChanged) {
        clearTimeout(waveTimer);
        waveTimer = window.setTimeout(() => {
          water.rebuildWaves(settings.windDirection);
          atmosphere.cameraChanged();
        }, 180);
      }
      if (contoursChanged) {
        render();
      } else {
        atmosphere.cameraChanged();
      }
    },
    dispose: () => {
      frameRenderer.dispose();
      clearTimeout(previewTimer);
      cancelAnimationFrame(previewFrame);
      cancelAnimationFrame(revealFrame);
      cancelAnimationFrame(frame);
      observer.disconnect();
      clearTimeout(waveTimer);
      playbackMotion.removeEventListener("change", pauseForReducedMotion);
      atmosphere.dispose();
      host.removeEventListener("atlas:current-time", setCurrentTime);
      controls.dispose();
      renderer.domElement.removeEventListener("pointerdown", pointerDown);
      renderer.domElement.removeEventListener("pointerup", pointerUp);
      renderer.domElement.removeEventListener("pointermove", pointerMove);
      renderer.domElement.removeEventListener("pointerleave", pointerLeave);
      ground.geometry.dispose();
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
      ecosystem.dispose();
      light.shadow.dispose();
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
      const reduced = playbackMotion.matches;
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
    getPlayback: playback.snapshot,
    getRenderStatus: pipeline.status,
    highlight: (territory: Territory | null) => {
      atmosphere.highlight(territory ?? focusedTerritory);
    },
    pinRegion: () => {
      selectedFile = null;
      selectedNeighborhood = undefined;
      render();
    },
    play: (value: boolean) => {
      playback.play(value);
      atmosphere.setCurrentTime(null);
      atmosphere.cameraChanged();
    },
    restorePlayback: (value: PlaybackSnapshot) => {
      playback.restore(value);
      if (playbackMotion.matches) {
        playback.play(false);
      }
      water.update(playback.snapshot(), currentStrength());
      atmosphere.cameraChanged();
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
    seek: (seconds: number) => {
      playback.play(false);
      seekCurrent(seconds * 1000);
    },
    setAtmosphere: atmosphere.setEnabled,
    setBelonging: (value: BelongingLayer | null) => {
      if (value?.featureFocus) {
        selectedFile = null;
        selectedNeighborhood = undefined;
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
      if (belonging && changed && !playbackMotion.matches) {
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
    setCurrentTime: seekCurrent,
    setPlaybackSpeed: (value: number) => {
      playback.speed(value);
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
      drawingData = resolveSetTerritoryLayout(territory, data);
      const current =
        data.territories.find((item) => item.id === selected) ?? null;
      focus(
        current,
        current?.files.find((item) => item.id === selectedFile),
        selectedNeighborhood
      );
    },
    setTrackPlaying: (id: TrackId, value: boolean) => {
      playback.track(id, value);
      atmosphere.cameraChanged();
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
  data: AtlasData
): AtlasData {
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

function resolvePointerMove(
  selection: AtlasSelection | null,
  selectedFile: string | null,
  host: HTMLElement,
  camera: OrthographicCamera,
  origin: { x: number; y: number },
  data: AtlasData,
  labels: MapLabel[]
): (() => MapPoint[] | null) | null {
  if (selection || selectedFile) {
    return null;
  }
  return () => {
    const scale =
      (host.clientWidth * camera.zoom) / (camera.right - camera.left);
    const path = windPath(origin, scale);
    const onscreen = path.every((p) => {
      const projected = new Vector3(p.x, -p.y, paperThickness + 0.04).project(
        camera
      );
      return Math.abs(projected.x) < 0.9 && Math.abs(projected.y) < 0.9;
    });
    return onscreen && clearWind(path, data, labels, 14 / scale) ? path : null;
  };
}

function hitTerritory(
  drawingData: AtlasData,
  point: Vector3,
  initialDistance: number,
  initialClosest: AtlasSelection | null,
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
  file: AtlasFile | undefined,
  camera: OrthographicCamera,
  host: HTMLElement,
  territory: Territory | null,
  fileIds: string[] | undefined,
  neighborhoodId: string | undefined,
  bounds: { height: number; width: number; x: number; y: number } | null,
  tilt: number,
  overviewZoom: number
): number {
  let zoom: number;
  if (file) {
    zoom = zoomForPixels(camera, host.clientWidth, 10);
  } else if (territory && !fileIds && !neighborhoodId) {
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
  labels: MapLabel[],
  tradeLayer: {
    dispose: () => void;
    group: Group<Object3DEventMap>;
    pick: (raycaster: Raycaster) => Territory | undefined;
    setRoutes: (routes: TradeRoute[]) => void;
  },
  controls: MapControls,
  tilt: 0.7,
  host: HTMLElement,
  responsibility: ResponsibilityOverlay | null,
  drawingData: AtlasData,
  visibility: { composition: boolean; files: boolean },
  playbackMotion: MediaQueryList,
  belonging: BelongingLayer | null,
  streams: boolean,
  pickTerrain: (point: Vector3) => Vector3 | undefined,
  event: PointerEvent
): AtlasSelection | null {
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
  const label = labels.find(
    (l) =>
      Math.abs(point.x - l.x) < l.width / 2 &&
      -point.y >= l.y - l.height &&
      -point.y <= l.y
  );
  if (label) {
    return {
      compositeId: label.compositeId,
      file: label.file,
      neighborhoodId: label.neighborhoodId,
      regionId: label.regionId,
      territory: label.territory,
    };
  }
  const surface = pickTerrain(point);
  if (surface) {
    point.copy(surface);
  }
  const port = tradeLayer.pick(raycaster);
  if (port) {
    return { territory: port };
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
      playbackMotion.matches,
      (host.clientWidth * camera.zoom) / (camera.right - camera.left)
    );
    if (compositionHit) {
      return compositionHit;
    }
  }
  let closest: AtlasSelection | null = null;
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
  drawingData: AtlasData,
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
  drawingData: AtlasData,
  point: Vector3,
  reducedMotion: boolean,
  pixels: number
): AtlasSelection | null {
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
): AtlasSelection | undefined {
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
