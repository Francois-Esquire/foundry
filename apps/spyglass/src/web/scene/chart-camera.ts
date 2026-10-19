import {
  MathUtils,
  OrthographicCamera,
  Plane,
  Raycaster,
  Vector2,
  Vector3,
} from "three";
import { MapControls } from "three/addons/controls/MapControls.js";
import { paperThickness } from "../data/bindings";
import type { SpyglassData, SpyglassFile, Territory } from "../data/types";
import {
  chartTilt,
  type InkView,
  inkView,
  keepSeaInFrame,
  zoomForPixels,
} from "../view/chart-view";

/** Where the camera looks and how close, as the host keeps it across a rebuild. */
export interface ChartView {
  pixels: number;
  x: number;
  y: number;
}

/** What a focus frames, and where: a file on an island, an island, or, with neither, the overview. */
export interface FocusFrame {
  file: SpyglassFile | undefined;
  target: Vector3;
  territory: Territory | null;
}

/** How long a flight to a place takes; the ease is quartic out. */
const flightMs = 650;
/** The elevation the chart is read at: the paper's top, where the flat marks lie. */
const inkElevation = paperThickness + 0.02;

/**
 * The chart's camera: a tilted orthographic view the reader pans and zooms
 * with MapControls, kept over the sea (`keepSeaInFrame`), fitted to the
 * viewport, and flown to places. Every change asks `onChange` for a frame.
 */
export function createChartCamera(options: {
  canvas: HTMLCanvasElement;
  data: SpyglassData;
  host: HTMLElement;
  onChange: () => void;
  reducedMotion: MediaQueryList;
  /** The sea's extent, wider than the chart by `panRoom`, which the view may not leave. */
  sea: { height: number; panRoom: number; width: number };
}) {
  const { canvas, data, host, onChange, reducedMotion, sea } = options;
  const tilt = chartTilt;
  const camera = new OrthographicCamera(-1, 1, 1, -1, 1, 10_000);
  camera.position.set(0, -Math.sin(tilt) * 2200, Math.cos(tilt) * 2200);
  camera.lookAt(0, 0, 0);
  const controls = new MapControls(camera, canvas);
  controls.enableRotate = false;
  controls.zoomToCursor = true;
  controls.screenSpacePanning = true;
  controls.enableDamping = false;
  controls.minZoom = 0.65;
  let flight = 0;
  let disposed = false;
  const cancelFlight = () => {
    cancelAnimationFrame(flight);
  };
  controls.addEventListener("change", onChange);
  controls.addEventListener("start", () => {
    cancelFlight();
    overview = false;
  });
  const raycaster = new Raycaster();
  const paper = new Plane(new Vector3(0, 0, 1), -paperThickness);
  let viewportWidth = 0;
  let overviewZoom = 1;
  let overview = true;
  /** The last focus flown to, which `resize` reads: a focused file stays readable, an island stays framed. */
  let focused: FocusFrame | null = null;
  const constrain = () =>
    keepSeaInFrame(
      camera,
      controls.target,
      tilt,
      sea.width,
      sea.height,
      Math.max(data.width, ((camera.right - camera.left) / camera.zoom) * 1.2),
      Math.max(
        data.height,
        ((camera.top - camera.bottom) / camera.zoom / Math.cos(tilt)) * 1.2
      ),
      1
    );
  const clampZoom = (zoom: number) =>
    MathUtils.clamp(zoom, controls.minZoom, controls.maxZoom);
  const moveTarget = (target: Vector3) => {
    const offset = camera.position.clone().sub(controls.target);
    controls.target.copy(target);
    camera.position.copy(controls.target).add(offset);
  };
  /** Flies to a place over `flightMs`, or at once under reduced motion; a new flight, a drag or `zoom` ends one in progress. */
  const flyTo = (destination: { target: Vector3; zoom: number }) => {
    if (disposed) {
      return;
    }
    const start = controls.target.clone();
    const zoomStart = camera.zoom;
    const began = performance.now();
    const reduced = reducedMotion.matches;
    cancelFlight();
    const landing = {
      target: destination.target.clone(),
      zoom: destination.zoom,
    };
    const animate = () => {
      const t = reduced
        ? 1
        : Math.min(1, (performance.now() - began) / flightMs);
      const ease = 1 - (1 - t) ** 4;
      const offset = camera.position.clone().sub(controls.target);
      controls.target.lerpVectors(start, landing.target, ease);
      camera.position.copy(controls.target).add(offset);
      camera.zoom = zoomStart + (landing.zoom - zoomStart) * ease;
      camera.updateProjectionMatrix();
      controls.update();
      onChange();
      if (t < 1) {
        flight = requestAnimationFrame(animate);
      }
    };
    animate();
  };
  /** The zoom a focus lands at: a file readable, an island at reading zoom, or the overview. */
  const focusZoom = ({ file, territory }: FocusFrame): number => {
    const width = host.clientWidth;
    if (file) {
      return zoomForPixels(camera, width, 10);
    }
    return territory ? zoomForPixels(camera, width, 2.2) : overviewZoom;
  };
  return {
    camera,
    captureView: (): ChartView => ({
      pixels: (host.clientWidth * camera.zoom) / (camera.right - camera.left),
      x: controls.target.x,
      y: controls.target.y,
    }),
    /** The point on the paper under a page point; none when the ray misses it. */
    chartPoint(page: { clientX: number; clientY: number }): Vector3 | null {
      const rect = canvas.getBoundingClientRect();
      camera.updateMatrixWorld();
      raycaster.setFromCamera(
        new Vector2(
          ((page.clientX - rect.left) / rect.width) * 2 - 1,
          (-(page.clientY - rect.top) / rect.height) * 2 + 1
        ),
        camera
      );
      return raycaster.ray.intersectPlane(paper, new Vector3());
    },
    /** Keeps the view over the sea; the least zoom that does. */
    constrain,
    dispose() {
      disposed = true;
      cancelFlight();
      controls.dispose();
    },
    flyTo,
    /** Flies to what a focus frames, and remembers it for `resize`. */
    focus(frame: FocusFrame) {
      overview = !(frame.territory || frame.file);
      focused = frame;
      flyTo({ target: frame.target, zoom: focusZoom(frame) });
    },
    /**
     * Fits the frustum to the host. The first fit starts at the overview;
     * later ones keep the zoom, so an island stays framed, or, while the
     * last focus was a file, the pixels per unit, so the file stays as
     * readable when the viewport changes.
     */
    resize() {
      const previousPixels =
        (viewportWidth * camera.zoom) / (camera.right - camera.left);
      const width = host.clientWidth;
      const height = Math.max(1, host.clientHeight);
      const aspect = width / height;
      const span = Math.max(data.height, data.width / aspect) * 1.05;
      camera.left = (-span * aspect) / 2;
      camera.right = (span * aspect) / 2;
      camera.top = span / 2;
      camera.bottom = -span / 2;
      controls.maxZoom = zoomForPixels(camera, width, 24);
      if (focused?.file && viewportWidth > 0) {
        camera.zoom = zoomForPixels(camera, width, previousPixels);
      }
      controls.minZoom = constrain();
      const sidePadding = Math.min(48, width * 0.08);
      const verticalPadding = Math.min(112, height * 0.2);
      overviewZoom = Math.max(
        controls.minZoom,
        Math.min(
          ((camera.right - camera.left) / Math.max(1, data.width)) *
            (1 - (2 * sidePadding) / width),
          ((camera.top - camera.bottom) / Math.max(1, data.height)) *
            (1 - (2 * verticalPadding) / height)
        )
      );
      if (!viewportWidth || overview) {
        camera.zoom = overviewZoom;
      }
      viewportWidth = width;
      camera.updateProjectionMatrix();
    },
    /** Puts the camera where a view was captured; a flight in progress ends, so it cannot carry the camera off again. */
    restoreView(view: ChartView) {
      overview = false;
      cancelFlight();
      moveTarget(new Vector3(view.x, view.y, 0));
      camera.zoom = clampZoom(
        zoomForPixels(camera, host.clientWidth, view.pixels)
      );
      camera.updateProjectionMatrix();
      controls.update();
    },
    /** Map units under one CSS pixel at this zoom. */
    unitsPerPixel: () =>
      (camera.right - camera.left) /
      (camera.zoom * Math.max(1, host.clientWidth)),
    /** The viewport in map units at the ink's elevation. */
    view: (): InkView =>
      inkView(camera, controls.target, tilt, inkElevation, host.clientWidth),
    zoom(factor: number) {
      overview = false;
      cancelFlight();
      camera.zoom = clampZoom(camera.zoom * factor);
      camera.updateProjectionMatrix();
    },
  };
}

export type ChartCamera = ReturnType<typeof createChartCamera>;
