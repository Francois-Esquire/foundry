import { Vector3 } from "three";
import { domainExtent } from "../../layout/domain-extent";
import {
  labelCandidates,
  labelEvidence,
  placeLabels,
} from "../../layout/label-candidates";
import { islandCaption } from "../../layout/label-proposals";
import {
  type IslandLabel,
  type LabelInputs,
  labelWorldPoint,
  type MapLabel,
} from "../../layout/labels";
import type { ReliefOf } from "../../layout/terrain-height";
import type { LabelLayer, LabelLayerInputs } from "../../scene/handle";
import type { ViewState } from "../../scene/view-state";
import type { InkView } from "../../view/chart-view";
import { detailLevel } from "../../view/detail-level";
import { createLabelItems, type IslandItem } from "./label-items";
import { createTextMetrics, type TextMetrics } from "./measure";
import {
  create,
  type Frame,
  letter,
  type ScreenPoint,
  setText,
  squash,
} from "./text-element";

/** What the labels layer is built over: the camera labels are projected through, the host the layer's root goes in, and the device's pixel ratio. */
export interface LabelsLayerOptions extends LabelLayerInputs {
  host: HTMLElement;
  /** The browser's measure of text, from an always-measurable host; a test passes its own. */
  metrics?: (root: HTMLElement) => TextMetrics;
  present?: (frame: Frame, metrics: TextMetrics) => void;
}

/**
 * Builds the chart in the host as one section of elements over the canvas,
 * positioned from the camera each frame, and returns it as a scene layer.
 * On each update it proposes and places the labels, publishes them to the
 * scene's state for the layers that clear around them and for the hit test,
 * then reconciles the elements (`label-items.ts`): each placed label is an
 * element kept by what it names, set in its font at its size, cut from its
 * halo and moved to its anchor's projection. A separate annotation update
 * presents chrome even while map labels are hidden. The layer takes no pointer events; Enter
 * or Space on a focused item selects what it names through `setActivation`.
 */
export function createLabelsLayer(options: LabelsLayerOptions): LabelLayer {
  const { camera, host, reliefOf } = options;
  const root = create(host, "section", "spyglass-labels");
  root.setAttribute("aria-label", "Chart");
  // Chrome still measures text while map labels are hidden. Keep its probes
  // outside the label root so display:none cannot poison the shared cache.
  const measureHost = create(host, "div", "spyglass-labels");
  measureHost.setAttribute("aria-hidden", "true");
  measureHost.inert = true;
  const metrics = (options.metrics ?? createTextMetrics)(measureHost);
  const items = createLabelItems(root);
  const namedIslands = new Set<IslandItem>();
  const projected = new Vector3();
  let candidateKeys: readonly unknown[] = [];
  let candidates: MapLabel[] = [];
  let placedCount = 0;
  let visible = true;

  /**
   * The labels proposed for the frame: kept while nothing they read has
   * changed, since a pan or a zoom changes what fits. The belonging layer
   * and the overlay are read as shown, one object that changes as any of
   * what it is resolved from does.
   */
  const propose = (frame: Frame): MapLabel[] => {
    const { state, view } = frame;
    const keys = [
      state.drawingData,
      state.shown,
      state.selected,
      state.selectedFile,
      state.domain,
      view.x,
      view.y,
      view.width,
      view.height,
      view.pixelsPerUnit,
    ];
    if (
      keys.length === candidateKeys.length &&
      keys.every((key, i) => Object.is(key, candidateKeys[i]))
    ) {
      return candidates;
    }
    candidateKeys = keys;
    candidates = labelCandidates(
      labelInputs(state, view, reliefOf),
      metrics.measure
    );
    return candidates;
  };

  /** Shows an island's name on its item, and notes the island as named this frame. */
  const showName = (label: IslandLabel, frame: Frame) => {
    const island = items.island(label.place.territory);
    if (island) {
      namedIslands.add(island);
      showIslandName(island, label, frame, metrics);
    }
  };

  /** Shows one placed item, in the island's list or among the captions, naming its place when it has one. */
  const showItem = (element: HTMLElement, label: MapLabel, frame: Frame) => {
    if (label.place) {
      items.place(element, label.place);
    }
    showLabel(element, label, frame, metrics);
  };

  const prepareFrame = (view: InkView, state: Readonly<ViewState>): Frame => {
    const pixels = view.pixelsPerUnit;
    const width = view.width * pixels;
    const height = view.height * pixels * squash;
    // The camera moved since the last frame drew it.
    camera.updateMatrixWorld();
    return {
      pixelRatio: options.pixelRatio(),
      pixels,
      screen(x, y, z) {
        projected.set(x, -y, z).project(camera);
        return {
          x: ((projected.x + 1) / 2) * width,
          y: ((1 - projected.y) / 2) * height,
        };
      },
      state,
      view,
    };
  };

  return {
    dispose() {
      items.dispose();
      metrics.dispose();
      measureHost.remove();
      root.remove();
    },
    id: "labels",
    kind: "labels",
    setActivation: items.setActivation,
    setVisible(next) {
      if (visible === next) {
        return;
      }
      visible = next;
      root.hidden = !next;
      root.inert = !next;
      candidateKeys = [];
      if (!next) {
        const focused = document.activeElement;
        if (focused instanceof HTMLElement && root.contains(focused)) {
          focused.blur();
        }
        placedCount = 0;
        options.publish([]);
      }
    },
    /** The labels proposed and placed last frame, and the elements lettered for them: the items shown and the islands named. */
    stats: () => ({
      candidates: candidates.length,
      elements: items.items.size + namedIslands.size,
      placed: placedCount,
    }),
    update(view, state) {
      if (!visible) {
        return;
      }
      const frame = prepareFrame(view, state);
      items.update(state.drawingData.territories);
      const placed = placeLabels(propose(frame), view, state.selectedFile);
      placedCount = placed.length;
      // Read first: every width and baseline is measured before an element
      // is written, so the frame lays the page out once.
      for (const label of placed) {
        metrics.baseline(label.font);
        if (label.kind === "island") {
          metrics.measure(label.caption, islandCaption.font);
          metrics.baseline(islandCaption.font);
        }
      }
      options.publish(placed);
      namedIslands.clear();
      for (const label of placed) {
        if (label.kind === "island") {
          showName(label, frame);
        }
      }
      items.items.reconcile(
        placed.filter((label) => label.kind !== "island"),
        (element, label) => showItem(element, label, frame)
      );
      for (const island of items.islands()) {
        if (!namedIslands.has(island)) {
          island.name.hidden = true;
        }
      }
    },
    updateAnnotations(view, state) {
      options.present?.(prepareFrame(view, state), metrics);
    },
  };
}

/** The labels' inputs, as the frame shows them: the belonging layer as drawn and the overlay in view off the state's `shown`, the detail level, and the relief a name on land sits on. */
function labelInputs(
  state: Readonly<ViewState>,
  view: InkView,
  reliefOf: ReliefOf
): LabelInputs {
  const { shown } = state;
  return {
    belonging: shown.belonging,
    composition: shown.responsibility?.composition,
    data: state.drawingData,
    detail: detailLevel(view.pixelsPerUnit, shown.hasComposition),
    domain: state.domain ? domainExtent(state.drawingData, state.domain) : null,
    evidenceFiles: labelEvidence(shown),
    fileId: state.selectedFile,
    reliefOf,
    selected: state.selected,
    view,
  };
}

/** Where a label's baseline centre falls on screen: its raised anchor, projected. */
function anchorOnScreen(label: MapLabel, frame: Frame): ScreenPoint {
  const point = labelWorldPoint(label);
  return frame.screen(point.x, point.y, point.z);
}

/**
 * Letters one placed label: at its size on screen, in its ink and halo, at
 * its opacity, its baseline centred on its anchor's projection.
 */
function showLabel(
  element: HTMLElement,
  label: MapLabel,
  frame: Frame,
  metrics: TextMetrics
): void {
  letter(element, label.font, label.ink, label.halo);
  element.style.opacity = `${label.opacity}`;
  setText(
    element,
    {
      align: "baseline",
      at: anchorOnScreen(label, frame),
      font: label.font,
      size: label.height * frame.pixels,
      text: label.text,
    },
    frame,
    metrics
  );
}

/**
 * Shows an island's name with its caption beneath: the caption's baseline
 * sits its drop below the name's, so its top margin makes up the
 * difference between the two lines' heights and baselines. The name's box
 * is the wider of the two lines, which centres both over the anchor.
 */
function showIslandName(
  island: IslandItem,
  label: IslandLabel,
  frame: Frame,
  metrics: TextMetrics
): void {
  const { caption, name, nameText } = island;
  const size = label.height * frame.pixels;
  const captionWidth =
    metrics.measure(label.caption, islandCaption.font) * islandCaption.size;
  name.hidden = false;
  if (nameText.data !== label.text) {
    nameText.data = label.text;
  }
  if (caption.textContent !== label.caption) {
    caption.textContent = label.caption;
  }
  letter(name, label.font, label.ink, label.halo);
  letter(caption, islandCaption.font, islandCaption.ink, islandCaption.halo);
  name.style.opacity = `${label.opacity}`;
  caption.style.fontSize = `${islandCaption.size}px`;
  caption.style.marginTop = `${islandCaption.drop - size * (1 - metrics.baseline(label.font)) - islandCaption.size * metrics.baseline(islandCaption.font)}px`;
  setText(
    name,
    {
      align: "baseline",
      at: anchorOnScreen(label, frame),
      font: label.font,
      size,
      text: label.text,
      width: Math.max(label.width * frame.pixels, captionWidth),
    },
    frame,
    metrics
  );
}
