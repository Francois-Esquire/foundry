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

/** What a focus frames: a file, an island, or some of an island's files. */
export interface FocusFrame {
  bounds: { height: number; width: number; x: number; y: number } | null;
  file: SpyglassFile | undefined;
  fileIds: string[] | undefined;
  territory: Territory | null;
}

/** How long a flight to a place takes; the ease is quartic out. */
const flightMs = 650;
/** The elevation the ink is read at: the paper's top, where the ink plane lies. */
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
  /** The sea sheet's extent, wider than the chart by `panRoom`, which the view may not leave. */
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
  controls.addEventListener("change", onChange);
  controls.addEventListener("start", () => cancelAnimationFrame(flight));
  const raycaster = new Raycaster();
  const paper = new Plane(new Vector3(0, 0, 1), -paperThickness);
  let viewportWidth = 0;
  let overviewZoom = 1;
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
      sea.panRoom
    );
  const clampZoom = (zoom: number) =>
    MathUtils.clamp(zoom, controls.minZoom, controls.maxZoom);
  const moveTarget = (target: Vector3) => {
    const offset = camera.position.clone().sub(controls.target);
    controls.target.copy(target);
    camera.position.copy(controls.target).add(offset);
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
      cancelAnimationFrame(flight);
      controls.dispose();
    },
    /** Flies to a place over `flightMs`, or at once under reduced motion; a new flight, a drag or `zoom` ends one in progress. */
    flyTo(destination: { target: Vector3; zoom: number }) {
      const start = controls.target.clone();
      const offset = camera.position.clone().sub(controls.target);
      const zoomStart = camera.zoom;
      const began = performance.now();
      const reduced = reducedMotion.matches;
      cancelAnimationFrame(flight);
      const animate = () => {
        const t = reduced
          ? 1
          : Math.min(1, (performance.now() - began) / flightMs);
        const ease = 1 - (1 - t) ** 4;
        controls.target.lerpVectors(start, destination.target, ease);
        camera.position.copy(controls.target).add(offset);
        camera.zoom = zoomStart + (destination.zoom - zoomStart) * ease;
        camera.updateProjectionMatrix();
        controls.update();
        onChange();
        if (t < 1) {
          flight = requestAnimationFrame(animate);
        }
      };
      animate();
    },
    /** The zoom a focus lands at: a file readable, an island at reading zoom, some files framed, or the overview. */
    focusZoom({ bounds, file, fileIds, territory }: FocusFrame): number {
      const width = host.clientWidth;
      if (file) {
        return zoomForPixels(camera, width, 10);
      }
      if (territory && !fileIds) {
        return zoomForPixels(camera, width, 2.2);
      }
      if (bounds) {
        return Math.min(
          12,
          (camera.right - camera.left) / (bounds.width * 1.4),
          (camera.top - camera.bottom) / (bounds.height * Math.cos(tilt) * 1.4)
        );
      }
      return territory ? zoomForPixels(camera, width, 2.2) : overviewZoom;
    },
    /**
     * Fits the frustum to the host. The first fit starts at the overview;
     * later ones keep the zoom, or, with `keepPixels`, the pixels per unit, so
     * a file stays as readable when the viewport changes.
     */
    resize(keepPixels: boolean) {
      const previousPixels =
        (viewportWidth * camera.zoom) / (camera.right - camera.left);
      const width = host.clientWidth;
      const aspect = width / Math.max(1, host.clientHeight);
      const span =
        Math.max(data.height * Math.cos(tilt), data.width / aspect) * 1.05;
      camera.left = (-span * aspect) / 2;
      camera.right = (span * aspect) / 2;
      camera.top = span / 2;
      camera.bottom = -span / 2;
      controls.maxZoom = zoomForPixels(camera, width, 24);
      if (keepPixels && viewportWidth > 0) {
        camera.zoom = zoomForPixels(camera, width, previousPixels);
      }
      controls.minZoom = constrain();
      overviewZoom = Math.max(controls.minZoom, aspect < 0.8 ? 2.15 : 1.14);
      if (!viewportWidth) {
        camera.zoom = overviewZoom;
      }
      viewportWidth = width;
      camera.updateProjectionMatrix();
    },
    /** Puts the camera where a view was captured; a flight in progress ends, so it cannot carry the camera off again. */
    restoreView(view: ChartView) {
      cancelAnimationFrame(flight);
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
      cancelAnimationFrame(flight);
      camera.zoom = clampZoom(camera.zoom * factor);
      camera.updateProjectionMatrix();
    },
  };
}

export type ChartCamera = ReturnType<typeof createChartCamera>;
