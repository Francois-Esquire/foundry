import type { Vector3 } from "three";
import type { FormerPackage } from "../data/types";
import type { BelongingLayer } from "../layout/belonging";
import type { MapLabel } from "../layout/labels";
import { featureIdentity } from "../layout/natural-feature-inspection";
import type { SpyglassScene } from "../scene/scene";
import { drawnBelonging } from "../scene/view-state";
import { chartTilt } from "../view/chart-view";
import { type HitContext, resolveHit } from "./hit";
import {
  createHoverTarget,
  hoveredIsland,
  type PagePoint,
} from "./hover-target";
import type { SpyglassSelection } from "./selection";
import { createTerrainPicker } from "./terrain-picking";

/** What the pointer tells the host. */
export interface PointerCallbacks {
  onHover: (selection: SpyglassSelection | null) => void;
  onSelect: (selection: SpyglassSelection | null) => void;
  /** Opens chart settings from the painted compass; without it the compass is inert. */
  onSettings?: () => void;
  onWreck?: (wreck: FormerPackage | null, selected: boolean) => void;
}

/** The part of the scene the pointer reads and sets. */
export type PointerScene = Pick<
  SpyglassScene,
  | "camera"
  | "canvas"
  | "data"
  | "render"
  | "setBelongingHover"
  | "setHoverResolver"
  | "state"
  | "terrain"
>;

/** A click moves the pointer less than this many CSS pixels between down and up. */
const clickSlop = 5;
/** The pointer rests this long over a place before it is previewed. */
const previewDelayMs = 90;
/** How long a previewed region's emphasis takes to come up. */
const emphasisMs = 180;
/** The compass rose's place and reach, in map units from the chart's south-east corner. */
const compass = { east: 88, north: 94, reach: 40 };

/**
 * Attaches the pointer to the scene's canvas: a click selects the place under
 * it (a drag does not), a wreck or the compass when one is there; resting
 * over a place previews it after `previewDelayMs`; moving inks the island
 * under the pointer, while dragging too; leaving clears all of it. Returns
 * `detach`, which removes the listeners and the hover resolver.
 */
export function attachPointer(
  scene: PointerScene,
  callbacks: PointerCallbacks
) {
  const { canvas } = scene;
  const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
  const places = createPlaces(scene, reducedMotion);
  const hoverTarget = createHoverTarget();
  let hoveredId: string | null = null;
  let down = { x: 0, y: 0 };
  const preview = createPreview(scene, callbacks, reducedMotion);

  const pointerDown = (e: PointerEvent) => {
    preview.hold();
    down = { x: e.clientX, y: e.clientY };
  };
  const pointerUp = (e: PointerEvent) => {
    if (Math.hypot(e.clientX - down.x, e.clientY - down.y) > clickSlop) {
      return;
    }
    const placed = places.place(e);
    if (!placed) {
      return;
    }
    const wreck = places.wreckAt(placed.point);
    if (wreck) {
      callbacks.onWreck?.(wreck, true);
      return;
    }
    if (callbacks.onSettings && places.onCompass(placed.point)) {
      callbacks.onSettings();
      return;
    }
    if (placed.selection || scene.state.selected) {
      callbacks.onSelect(placed.selection);
    }
  };
  const pointerMove = (e: PointerEvent) => {
    // Kept while dragging too: a pan follows the pointer, so the island
    // under it stays the one inked.
    hoverTarget.move(e);
    if (e.buttons) {
      return;
    }
    const placed = places.place(e);
    const selection = placed?.selection ?? null;
    const wreck = placed ? places.wreckAt(placed.point) : null;
    callbacks.onWreck?.(wreck, false);
    const atCompass =
      !!callbacks.onSettings && !!placed && places.onCompass(placed.point);
    canvas.style.cursor = selection || atCompass || wreck ? "pointer" : "grab";
    preview.rest(selection);
    if ((selection?.territory.id ?? null) !== hoveredId) {
      scene.render();
    }
  };
  const pointerLeave = () => {
    preview.leave();
    callbacks.onHover(null);
    callbacks.onWreck?.(null, false);
    hoverTarget.leave();
    if (hoveredId) {
      scene.render();
    }
  };
  scene.setHoverResolver((labels) => {
    hoveredId = hoverTarget.island(
      (pointer) => places.place(pointer, labels)?.selection?.territory.id
    );
    return hoveredIsland(
      hoveredId,
      scene.state.drawingData.territories,
      scene.state.selected
    );
  });
  canvas.addEventListener("pointerdown", pointerDown);
  canvas.addEventListener("pointerup", pointerUp);
  canvas.addEventListener("pointermove", pointerMove);
  canvas.addEventListener("pointerleave", pointerLeave);
  return {
    detach() {
      preview.cancel();
      scene.setHoverResolver(null);
      canvas.removeEventListener("pointerdown", pointerDown);
      canvas.removeEventListener("pointerup", pointerUp);
      canvas.removeEventListener("pointermove", pointerMove);
      canvas.removeEventListener("pointerleave", pointerLeave);
    },
  };
}

/** The hit tests over the scene: the place under a page point, and the wreck or the compass at a chart point. */
function createPlaces(scene: PointerScene, reducedMotion: MediaQueryList) {
  const { data } = scene;
  const pickTerrain = createTerrainPicker(scene.terrain, chartTilt);
  const context = (labels: readonly MapLabel[]): HitContext => ({
    belonging: drawnBelonging(scene.state),
    data: scene.state.drawingData,
    labels,
    pickTerrain,
    reducedMotion: reducedMotion.matches,
    responsibility: scene.state.responsibility,
    streams: scene.state.settings.streams,
    view: scene.camera.view(),
    visibility: scene.state.visibility,
  });
  return {
    onCompass: (point: Vector3) =>
      Math.hypot(
        point.x - (data.width / 2 - compass.east),
        -point.y - (-data.height / 2 + compass.north)
      ) < compass.reach,
    /** The place under a page point, and the point itself, lifted to the land there. */
    place(page: PagePoint, labels: readonly MapLabel[] = scene.state.labels) {
      const point = scene.camera.chartPoint(page);
      return point && { point, selection: resolveHit(context(labels), point) };
    },
    wreckAt(point: Vector3) {
      const pixels = scene.camera.view().pixelsPerUnit;
      return (
        data.formerPackages?.find(
          (wreck) =>
            Math.hypot(point.x - wreck.x, -point.y - wreck.y) <
            Math.max(16, 12 / pixels)
        ) ?? null
      );
    },
  };
}

/** The key of a place, by which a rest over it is told from the last. */
function placeKey(selection: SpyglassSelection | null): string {
  if (!selection) {
    return "";
  }
  const what =
    selection.file?.id ??
    (featureIdentity(selection.feature) || undefined) ??
    selection.regionId ??
    selection.compositeId ??
    "";
  return `${selection.territory.id}:${what}`;
}

/**
 * The preview: a rest over a place is reported to the host after
 * `previewDelayMs`, and, while a belonging layer is shown, the region or
 * feature under the pointer is emphasised over `emphasisMs`. The preview
 * belongs to the belonging layer it began over: when the scene applies
 * another, a pending rest and a running emphasis end, as a fresh layer
 * carries no hover.
 */
function createPreview(
  scene: PointerScene,
  callbacks: Pick<PointerCallbacks, "onHover">,
  reducedMotion: MediaQueryList
) {
  let timer = 0;
  let frame = 0;
  let key = "";
  let over: BelongingLayer | null = scene.state.belonging;
  const cancel = () => {
    clearTimeout(timer);
    cancelAnimationFrame(frame);
  };
  /** Drops the bookkeeping when the belonging layer is not the one it was kept for. */
  const follow = () => {
    if (scene.state.belonging !== over) {
      over = scene.state.belonging;
      key = "";
      cancel();
      return false;
    }
    return true;
  };
  const emphasise = (selection: SpyglassSelection | null) => {
    const { belonging } = scene.state;
    if (!belonging) {
      return;
    }
    cancelAnimationFrame(frame);
    const hover = {
      feature: selection?.feature,
      hovered: selection?.regionId ?? selection?.compositeId,
    };
    const start = performance.now();
    const animate = () => {
      if (scene.state.belonging !== belonging) {
        return;
      }
      const progress = reducedMotion.matches
        ? 1
        : Math.min(1, (performance.now() - start) / emphasisMs);
      scene.setBelongingHover({ ...hover, emphasis: 1 - (1 - progress) ** 3 });
      if (progress < 1) {
        frame = requestAnimationFrame(animate);
      }
    };
    animate();
  };
  return {
    cancel,
    /** A press: a rest not yet previewed is forgotten; an emphasis coming up finishes. */
    hold() {
      clearTimeout(timer);
    },
    /** The pointer left: the host hears no hover, and the hover over the belonging layer lifts. */
    leave() {
      cancel();
      key = "";
      const { belonging, belongingHover } = scene.state;
      const hovering =
        belongingHover?.hovered ||
        belongingHover?.feature ||
        belonging?.featureFocus;
      if (belonging && hovering) {
        scene.setBelongingHover(
          belongingHover && { emphasis: belongingHover.emphasis }
        );
      }
    },
    /** The pointer rests over a place: a new one is previewed after the delay. */
    rest(selection: SpyglassSelection | null) {
      follow();
      const next = placeKey(selection);
      if (next === key) {
        return;
      }
      key = next;
      clearTimeout(timer);
      timer = window.setTimeout(() => {
        if (!follow()) {
          return;
        }
        callbacks.onHover(selection);
        emphasise(selection);
      }, previewDelayMs);
    },
  };
}
