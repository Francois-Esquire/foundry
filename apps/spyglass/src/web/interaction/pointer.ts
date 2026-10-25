import type { Vector3 } from "three";
import type { FormerPackage } from "../data/types";
import type { BelongingLayer } from "../layout/belonging";
import { featureIdentity } from "../layout/natural-feature-inspection";
import type { SpyglassScene } from "../scene/scene";
import { isSceneLayerVisible } from "../settings/scene-composition";
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
  | "setLabelActivation"
  | "state"
  | "terrain"
>;

/** A click moves the pointer less than this many CSS pixels between down and up. */
const clickSlop = 5;
/** The pointer rests this long over a place before it is previewed. */
const previewDelayMs = 90;
/** How long a previewed region's emphasis takes to come up. */
const emphasisMs = 180;
/**
 * Attaches the pointer to the scene's canvas: a click selects the place under
 * it (a drag does not), or a wreck when one is there; resting
 * over a place previews it after `previewDelayMs`; moving inks the island
 * under the pointer, while dragging too; leaving clears all of it. A
 * keyboard activation of a label item selects what it names, as a click on
 * it would. Returns `detach`, which removes the listeners, the hover
 * resolver and the activation.
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
  let { composition } = scene.state.settings;

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
    canvas.style.cursor = selection || wreck ? "pointer" : "grab";
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
  scene.setHoverResolver(() => {
    if (composition !== scene.state.settings.composition) {
      ({ composition } = scene.state.settings);
      preview.leave();
      callbacks.onHover(null);
      callbacks.onWreck?.(null, false);
      canvas.style.cursor = "grab";
    }
    hoveredId = hoverTarget.island(
      (pointer) => places.place(pointer)?.selection?.territory.id
    );
    return hoveredIsland(
      hoveredId,
      scene.state.drawingData.territories,
      scene.state.selected
    );
  });
  scene.setLabelActivation((place) => {
    if (isSceneLayerVisible(scene.state.settings.composition, "labels")) {
      callbacks.onSelect(place);
    }
  });
  canvas.addEventListener("pointerdown", pointerDown);
  canvas.addEventListener("pointerup", pointerUp);
  canvas.addEventListener("pointermove", pointerMove);
  canvas.addEventListener("pointerleave", pointerLeave);
  return {
    detach() {
      preview.cancel();
      scene.setHoverResolver(null);
      scene.setLabelActivation(null);
      canvas.removeEventListener("pointerdown", pointerDown);
      canvas.removeEventListener("pointerup", pointerUp);
      canvas.removeEventListener("pointermove", pointerMove);
      canvas.removeEventListener("pointerleave", pointerLeave);
    },
  };
}

/** The hit tests over the scene: the place under a page point, and the wreck at a chart point. */
function createPlaces(scene: PointerScene, reducedMotion: MediaQueryList) {
  const { data } = scene;
  /**
   * The terrain is indexed as the camera projects it, so the picker is built
   * for the camera's tilt and again when the tilt has changed since.
   */
  let picker: {
    pick: ReturnType<typeof createTerrainPicker>;
    tilt: number;
  } | null = null;
  const terrainPicker = (tilt: number) => {
    if (picker?.tilt !== tilt) {
      picker = { pick: createTerrainPicker(scene.terrain, tilt), tilt };
    }
    return picker.pick;
  };
  /** The frame's labels are read off the state: the labels layer publishes them before the resolver and any hit test run. */
  const context = (): HitContext => {
    const view = scene.camera.view();
    return {
      composition: scene.state.settings.composition,
      data: scene.state.drawingData,
      labels: scene.state.labels,
      pickTerrain: terrainPicker(view.tilt ?? chartTilt),
      reducedMotion: reducedMotion.matches,
      selectedFile: scene.state.selectedFile,
      shown: scene.state.shown,
      streams: scene.state.settings.streams,
      view,
      visibility: scene.state.visibility,
    };
  };
  return {
    /** The place under a page point, and the point itself, lifted to the land there. */
    place(page: PagePoint) {
      const point = scene.camera.chartPoint(page);
      return point && { point, selection: resolveHit(context(), point) };
    },
    wreckAt(point: Vector3) {
      if (!isSceneLayerVisible(scene.state.settings.composition, "wrecks")) {
        return null;
      }
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
  let { composition } = scene.state.settings;
  const cancel = () => {
    clearTimeout(timer);
    cancelAnimationFrame(frame);
  };
  /** Drops the bookkeeping when the belonging layer is not the one it was kept for. */
  const follow = () => {
    if (
      scene.state.belonging !== over ||
      scene.state.settings.composition !== composition
    ) {
      ({ composition } = scene.state.settings);
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
      if (
        scene.state.belonging !== belonging ||
        scene.state.settings.composition !== composition
      ) {
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
