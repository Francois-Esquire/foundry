import {
  type LabelScreen,
  labelCandidates,
  placeLabels,
} from "../../layout/label-candidates";
import type { LabelLayer, LabelLayerInputs } from "../../layout/label-layer";
import { islandCaption } from "../../layout/label-proposals";
import {
  type IslandLabel,
  type LabelInputs,
  labelWorldPoint,
  type MapLabel,
} from "../../layout/labels";
import type { ViewState } from "../../layout/view-state";
import { type InkView, viewSquash } from "../../view/chart-view";
import { detailLevel } from "../../view/detail-level";
import type { FileAt } from "../../view/file-place";
import { screenExclusions } from "./exclusions";
import { createLabelItems, type IslandItem } from "./label-items";
import { createTextMetrics, type TextMetrics } from "./measure";
import {
  create,
  type Frame,
  letter,
  type ScreenPoint,
  setText,
} from "./text-element";

/** What the labels layer is built over: the projection labels are placed with, the host the layer's root goes in, and the device's pixel ratio. */
export interface LabelsLayerOptions extends LabelLayerInputs {
  host: HTMLElement;
  /** The browser's measure of text, from an always-measurable host; a test passes its own. */
  metrics?: (root: HTMLElement) => TextMetrics;
  present?: (frame: Frame, metrics: TextMetrics) => void;
}

/**
 * Builds the chart in the host as one section of elements over the canvas,
 * positioned from the map's projection each frame, and returns it as a layer.
 * On each update it proposes and places the labels, publishes them to the
 * map's view state, then reconciles the elements (`label-items.ts`): each placed label is an
 * element kept by what it names, set in its font at its size, cut from its
 * halo and moved to its anchor's projection. A separate annotation update
 * presents chrome even while map labels are hidden. The layer takes no pointer events; Enter
 * or Space on a focused item selects what it names through `setActivation`.
 */
export function createLabelsLayer(options: LabelsLayerOptions): LabelLayer {
  const { host, project } = options;
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
  let candidateKeys: readonly unknown[] = [];
  let candidates: MapLabel[] = [];
  let placedCount = 0;
  let visible = true;

  /**
   * The labels proposed for the frame: kept while nothing they read has
   * changed, since a pan or a zoom changes what fits.
   */
  const propose = (frame: Frame): MapLabel[] => {
    const { state, view } = frame;
    const keys = [
      state.drawingData,
      state.selected,
      state.selectedFile,
      view.x,
      view.y,
      view.width,
      view.height,
      view.pixelsPerUnit,
      view.tilt,
      state.settings.composition,
    ];
    if (
      keys.length === candidateKeys.length &&
      keys.every((key, i) => Object.is(key, candidateKeys[i]))
    ) {
      return candidates;
    }
    candidateKeys = keys;
    candidates = labelCandidates(
      labelInputs(state, view, options.fileAt),
      metrics.measure
    );
    return candidates;
  };

  const showName = (label: IslandLabel, frame: Frame) => {
    const island = items.island(label.place.territory);
    if (island) {
      namedIslands.add(island);
      showIslandName(island, label, frame, metrics);
    }
  };

  const showItem = (element: HTMLElement, label: MapLabel, frame: Frame) => {
    if (label.place) {
      items.place(element, label.place);
    }
    showLabel(element, label, frame, metrics);
  };

  const retireUnplacedNames = () => {
    for (const island of items.islands()) {
      const named = namedIslands.has(island);
      island.item.tabIndex = named ? 0 : -1;
      if (!named) {
        island.name.hidden = true;
        if (document.activeElement === island.item) {
          island.item.blur();
        }
      }
    }
  };

  const prepareFrame = (view: InkView, state: Readonly<ViewState>): Frame => ({
    exclusions: screenExclusions(host),
    pixelRatio: options.pixelRatio(),
    pixels: view.pixelsPerUnit,
    screen: project(view),
    state,
    view,
  });

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
      const placed = placeLabels(
        propose(frame),
        screenOf(frame),
        state.selectedFile,
        frame.exclusions
      );
      placedCount = placed.length;
      // Measure before writing label elements to avoid interleaving layout reads and writes.
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
      retireUnplacedNames();
    },
    updateAnnotations(view, state) {
      options.present?.(prepareFrame(view, state), metrics);
    },
  };
}

function labelInputs(
  state: Readonly<ViewState>,
  view: InkView,
  fileAt: FileAt | undefined
): LabelInputs {
  return {
    data: state.drawingData,
    detail: detailLevel(view.pixelsPerUnit),
    ...(fileAt && { fileAt }),
    fileId: state.selectedFile,
    selected: state.selected,
    view,
  };
}

/**
 * The canvas as the labels are placed on it: its size in CSS pixels (the
 * view's extent at its centre, times the scale there and, north to south,
 * the tilt's foreshortening, which `inkViewOf` divided out), and each
 * label's anchor by the projection that letters it, so what is placed is
 * where it is drawn.
 */
function screenOf(frame: Frame): LabelScreen {
  const { view } = frame;
  return {
    at: (label) => anchorOnScreen(label, frame),
    height: view.height * view.pixelsPerUnit * viewSquash(view),
    pixelsPerUnit: frame.pixels,
    width: view.width * view.pixelsPerUnit,
  };
}

function anchorOnScreen(label: MapLabel, frame: Frame): ScreenPoint {
  const point = labelWorldPoint(label, frame.view.tilt);
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
  caption.hidden = label.caption === "";
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
