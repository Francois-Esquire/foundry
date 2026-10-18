import { type OrthographicCamera, Vector3 } from "three";
import type { SpyglassData, Territory } from "../../data/types";
import { channels, inks } from "../../ladder/ink-ladder";
import { belongingView } from "../../layout/belonging-view";
import { domainExtent } from "../../layout/domain-extent";
import {
  islandCaption,
  type LabelInputs,
  labelCandidates,
  placeLabels,
} from "../../layout/label-candidates";
import {
  type LabelFont,
  labelWorldPoint,
  type MapLabel,
} from "../../layout/labels";
import {
  compassLetter,
  type GridReference,
  gridReferences,
  type LatitudeScale,
  latitudeScale,
  latitudeScaleStyle,
  marginNote,
  seaCaption,
  type WorldNote,
} from "../../layout/margin-notes";
import { flatMarkHeight } from "../../layout/terrain-height";
import { chartTilt, type InkView } from "../../view/chart-view";
import { detailLevel } from "../../view/detail-level";
import type { LabelActivation, LabelPlace, SceneLayer } from "../handle";
import { drawnBelonging, type ViewState } from "../view-state";
import { createTextMetrics, fontFamily, type TextMetrics } from "./measure";

/** What the labels layer is built over: the camera labels are projected through, the host the layer's root goes in, and the device's pixel ratio. */
export interface LabelsLayerOptions {
  camera: OrthographicCamera;
  host: HTMLElement;
  /** The browser's measure of text, from the layer's root; a test passes its own. */
  metrics?: (root: HTMLElement) => TextMetrics;
  pixelRatio: () => number;
  /** Hands the frame's placed labels to the scene's state, before the layers that clear around them run. */
  publish: (labels: MapLabel[]) => void;
}

/** The tilt's foreshortening: lettering on the chart is squashed by it, as the engraved look has it. */
const squash = Math.cos(chartTilt);

const svgNamespace = "http://www.w3.org/2000/svg";

/** The paper plate under a latitude number on a narrow view: the labels' halo paper, at the plate's alpha. */
const plate = `rgb(${channels(inks.labelHalo).join(" ")} / ${latitudeScaleStyle.plateAlpha})`;

/** A point on screen, in CSS pixels of the host. */
interface ScreenPoint {
  x: number;
  y: number;
}

/**
 * Rounds to the device's pixels. A fractional translate has Chrome
 * rasterise the glyphs again at each offset, which shimmers through a pan;
 * snapped, the glyphs are the same pixels every frame and the text sits at
 * most half a device pixel off the marks, which never accumulates (measured
 * in 4e with `scripts/capture.ts`'s `shift` step).
 */
function snap(value: number, pixelRatio: number): number {
  return Math.round(value * pixelRatio) / pixelRatio;
}

/**
 * Sets an element at a screen point: its top-left corner there, squashed
 * north to south about its top by the tilt, as the lettering canvas was.
 */
function moveTo(
  element: HTMLElement,
  left: number,
  top: number,
  pixelRatio: number
): void {
  element.style.transform = `translate(${snap(left, pixelRatio)}px, ${snap(top, pixelRatio)}px) scaleY(${squash})`;
}

/** Sets how a text is lettered: its face, italics, the space between its letters, its ink and the paper halo it is cut from. */
function letter(
  element: HTMLElement,
  font: LabelFont,
  ink: string,
  halo: number,
  haloInk: string = inks.labelHalo
): void {
  element.style.fontFamily = fontFamily(font);
  element.style.fontStyle = font.italic ? "italic" : "normal";
  element.style.letterSpacing = `${font.letterSpacing ?? 0}em`;
  element.style.color = ink;
  element.style.webkitTextStroke = halo ? `${halo}px ${haloInk}` : "";
}

function create<K extends keyof HTMLElementTagNameMap>(
  parent: Element,
  tag: K,
  className: string
): HTMLElementTagNameMap[K] {
  const element = document.createElement(tag);
  element.className = className;
  parent.append(element);
  return element;
}

/** Everything one update of the layer reads: the view, the frame's state, and the screen. */
interface Frame {
  pixelRatio: number;
  pixels: number;
  /** A chart point (y south) at a world height, on screen. */
  screen: (x: number, y: number, z: number) => ScreenPoint;
  state: Readonly<ViewState>;
  view: InkView;
}

/** The island items: one per island, always present, each holding its name and the labels on it. */
interface IslandItem {
  caption: HTMLSpanElement;
  item: HTMLLIElement;
  labels: HTMLUListElement;
  name: HTMLSpanElement;
  nameText: Text;
}

/**
 * The list of islands: one focusable item per island, named for assistive
 * technology with its package and file count, holding the island's name
 * (shown when placed) and a nested list of the folders, regions and files
 * labelled on it. Rebuilt when the islands change, since a relayout
 * replaces them.
 */
function createIslandList(
  parent: HTMLElement,
  places: WeakMap<HTMLElement, LabelPlace>
) {
  const list = create(parent, "ul", "spyglass-islands");
  const items = new Map<string, IslandItem>();
  let territories: readonly Territory[] | undefined;
  const build = (next: readonly Territory[]) => {
    territories = next;
    const seen = new Set<string>();
    for (const territory of next) {
      seen.add(territory.id);
      let island = items.get(territory.id);
      if (!island) {
        const item = create(list, "li", "spyglass-island");
        item.tabIndex = 0;
        const name = create(
          item,
          "span",
          "spyglass-label spyglass-island-name"
        );
        name.hidden = true;
        const nameText = document.createTextNode("");
        name.append(nameText);
        const caption = create(name, "span", "spyglass-caption");
        const labels = create(item, "ul", "spyglass-island-labels");
        island = { caption, item, labels, name, nameText };
        items.set(territory.id, island);
      }
      const count = territory.files.length;
      island.item.setAttribute(
        "aria-label",
        `${territory.label}, package, ${count.toLocaleString("en")} ${count === 1 ? "file" : "files"}`
      );
      places.set(island.item, { territory });
    }
    for (const [id, island] of items) {
      if (!seen.has(id)) {
        island.item.remove();
        items.delete(id);
      }
    }
  };
  return {
    /** The island's item, after the islands as drawn are reconciled. */
    island(territory: Territory): IslandItem | undefined {
      return items.get(territory.id);
    },
    update(next: readonly Territory[]) {
      if (next !== territories) {
        build(next);
      }
    },
  };
}

/** The key an element is kept by: what it names and says, so a pan or a zoom moves it rather than replacing it. */
function keyOf(label: MapLabel): string {
  const named =
    label.file?.id ?? label.regionId ?? label.compositeId ?? label.frame ?? "";
  return `${label.kind}|${label.territory?.id ?? ""}|${named}|${label.text}`;
}

/**
 * Builds the chart in the host as one section of elements over the canvas,
 * positioned from the camera each frame, and returns it as a scene layer.
 * On each update it proposes and places the labels, publishes them to the
 * scene's state for the layers that clear around them and for the hit test, then
 * reconciles the elements: each placed label is an element kept by what it
 * names, set in its font at its size, cut from its halo and moved to its
 * anchor's projection; margin notes are set in screen space. The layer takes
 * no pointer events; Enter or Space on a focused item selects what it names
 * through `setActivation`.
 */
export function createLabelsLayer(options: LabelsLayerOptions): SceneLayer & {
  setActivation: (handler: LabelActivation | null) => void;
} {
  const { camera, host } = options;
  const root = create(host, "section", "spyglass-labels");
  root.setAttribute("aria-label", "Chart");
  const metrics = (options.metrics ?? createTextMetrics)(root);
  const places = new WeakMap<HTMLElement, LabelPlace>();
  const islands = createIslandList(root, places);
  const captions = create(root, "ul", "spyglass-captions");
  const margin = create(root, "div", "spyglass-margin");
  margin.setAttribute("aria-hidden", "true");
  const notes = createMarginNotes(margin, metrics);
  const shown = new Map<string, HTMLElement>();
  const namedIslands = new Set<string>();
  const projected = new Vector3();
  let activation: LabelActivation | null = null;
  let candidateKeys: readonly unknown[] = [];
  let candidates: MapLabel[] = [];

  const activate = (event: KeyboardEvent) => {
    if (event.key !== "Enter" && event.key !== " ") {
      return;
    }
    const place =
      event.target instanceof HTMLElement ? places.get(event.target) : null;
    if (place && activation) {
      event.preventDefault();
      activation(place);
    }
  };
  root.addEventListener("keydown", activate);

  /** The labels proposed for the frame: kept while nothing they read has changed, since a pan or a zoom changes what fits. */
  const propose = (frame: Frame): MapLabel[] => {
    const { state, view } = frame;
    const keys = [
      state.drawingData,
      state.belonging,
      state.belongingHover,
      state.belongingReveal,
      state.matches,
      state.responsibility,
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
    candidates = labelCandidates(labelInputs(state, view), metrics.measure);
    return candidates;
  };

  /** Shows one placed label: the island's own name, or an item in the island's list or among the captions. */
  const show = (label: MapLabel, frame: Frame, seen: Set<string>) => {
    if (label.kind === "island" && label.territory) {
      const island = islands.island(label.territory);
      if (island) {
        namedIslands.add(label.territory.id);
        showIslandName(island, label, frame, metrics);
      }
      return;
    }
    const key = keyOf(label);
    seen.add(key);
    const onIsland =
      label.territory && label.kind !== "domain" && label.kind !== "frame"
        ? islands.island(label.territory)
        : undefined;
    let element = shown.get(key);
    if (!element) {
      element = createItem(
        onIsland?.labels ?? captions,
        label,
        frame.state.drawingData
      );
      shown.set(key, element);
    }
    if (onIsland && label.territory) {
      // The island as drawn now, since a relayout replaces it.
      places.set(element, {
        compositeId: label.compositeId,
        file: label.file,
        regionId: label.regionId,
        territory: label.territory,
      });
    }
    showLabel(element, label, frame, metrics);
  };

  return {
    dispose() {
      root.removeEventListener("keydown", activate);
      metrics.dispose();
      root.remove();
    },
    id: "labels",
    setActivation(handler) {
      activation = handler;
    },
    update(view, state) {
      const pixels = view.pixelsPerUnit;
      const width = view.width * pixels;
      const height = view.height * pixels * squash;
      // The camera moved since the last frame drew it.
      camera.updateMatrixWorld();
      const frame: Frame = {
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
      islands.update(state.drawingData.territories);
      const placed = placeLabels(propose(frame), view, state.selectedFile);
      // Read first: every width and baseline is measured before an element
      // is written, so the frame lays the page out once.
      for (const label of placed) {
        metrics.baseline(label.font);
        if (label.caption) {
          metrics.measure(label.caption, islandCaption.font);
          metrics.baseline(islandCaption.font);
        }
      }
      options.publish(placed);
      const seen = new Set<string>();
      namedIslands.clear();
      for (const label of placed) {
        show(label, frame, seen);
      }
      for (const [key, element] of shown) {
        if (!seen.has(key)) {
          element.remove();
          shown.delete(key);
        }
      }
      for (const territory of state.drawingData.territories) {
        const island = islands.island(territory);
        if (island && !namedIslands.has(territory.id)) {
          island.name.hidden = true;
        }
      }
      notes.update(frame, placed);
    },
  };
}

/** The labels' inputs, as the frame's state resolves against the view: the belonging layer as drawn, the overlay in view, the detail level. */
function labelInputs(state: Readonly<ViewState>, view: InkView): LabelInputs {
  const resolved = belongingView({
    belonging: drawnBelonging(state),
    fileId: state.selectedFile,
    matches: state.matches,
    responsibility: state.responsibility,
    selected: state.selected,
    territories: state.drawingData.territories,
    view,
  });
  const { activeRegion } = resolved;
  return {
    belonging: resolved.belonging,
    composition: resolved.responsibility?.composition,
    data: state.drawingData,
    detail: detailLevel(view.pixelsPerUnit, resolved.hasComposition),
    domain: state.domain ? domainExtent(state.drawingData, state.domain) : null,
    evidenceFiles:
      resolved.evidenceFiles ??
      (activeRegion
        ? new Set(activeRegion.members.map((file) => file.id))
        : undefined),
    fileId: state.selectedFile,
    selected: state.selected,
    view,
  };
}

/**
 * A placed label's item, in an island's list or among the captions: named
 * for assistive technology by what it names, and focusable when it names a
 * place on an island.
 */
function createItem(
  parent: HTMLUListElement,
  label: MapLabel,
  data: Pick<SpyglassData, "frames">
): HTMLLIElement {
  const element = create(parent, "li", `spyglass-label spyglass-${label.kind}`);
  element.textContent = label.text;
  if (label.kind === "frame") {
    const frameLabel = data.frames.find(
      (each) => each.id === label.frame
    )?.label;
    element.setAttribute("aria-label", `${frameLabel ?? label.text}, frame`);
  } else if (label.territory && label.kind !== "domain") {
    element.tabIndex = 0;
    element.setAttribute("aria-label", `${label.text}, ${label.kind}`);
  }
  return element;
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
  const size = label.height * frame.pixels;
  const width = label.width * frame.pixels;
  const anchor = anchorOnScreen(label, frame);
  letter(element, label.font, label.ink, label.halo);
  element.style.fontSize = `${size}px`;
  element.style.opacity = `${label.opacity ?? 1}`;
  moveTo(
    element,
    anchor.x - width / 2,
    anchor.y - squash * metrics.baseline(label.font) * size,
    frame.pixelRatio
  );
}

/**
 * Shows an island's name with its caption beneath: the caption's baseline
 * sits its drop below the name's, so its top margin makes up the
 * difference between the two lines' heights and baselines.
 */
function showIslandName(
  island: IslandItem,
  label: MapLabel,
  frame: Frame,
  metrics: TextMetrics
): void {
  const { caption, name, nameText } = island;
  const size = label.height * frame.pixels;
  const nameWidth = label.width * frame.pixels;
  const captionWidth = label.caption
    ? metrics.measure(label.caption, islandCaption.font) * islandCaption.size
    : 0;
  const width = Math.max(nameWidth, captionWidth);
  const baseline = metrics.baseline(label.font);
  const anchor = anchorOnScreen(label, frame);
  name.hidden = false;
  if (nameText.data !== label.text) {
    nameText.data = label.text;
  }
  letter(name, label.font, label.ink, label.halo);
  name.style.fontSize = `${size}px`;
  name.style.opacity = `${label.opacity ?? 1}`;
  if (label.caption) {
    if (caption.textContent !== label.caption) {
      caption.textContent = label.caption;
    }
    caption.hidden = false;
    letter(caption, islandCaption.font, islandCaption.ink, islandCaption.halo);
    caption.style.fontSize = `${islandCaption.size}px`;
    caption.style.marginTop = `${islandCaption.drop - size * (1 - baseline) - islandCaption.size * metrics.baseline(islandCaption.font)}px`;
  } else {
    caption.hidden = true;
  }
  moveTo(
    name,
    anchor.x - width / 2,
    anchor.y - squash * baseline * size,
    frame.pixelRatio
  );
}

/**
 * The margin notes, hidden from assistive technology: grid references along
 * the top and left margins, the latitude scale in the right margin, both in
 * screen space; the sea's caption and the compass letter anchored to the
 * chart, their size in pixels per unit, so they scale with the zoom as the
 * painted ones did. Each update lays the notes out and measures them first,
 * then writes.
 */
function createMarginNotes(parent: HTMLElement, metrics: TextMetrics) {
  const references = new Map<string, HTMLSpanElement>();
  const scale = create(parent, "div", "spyglass-latitude");
  const axis = document.createElementNS(svgNamespace, "svg");
  axis.setAttribute("class", "spyglass-latitude-axis");
  scale.append(axis);
  const { axis: axisStyle } = latitudeScaleStyle;
  const axisLine = tickLine(axis, axisStyle);
  const ticks = new Map<
    number,
    { line: SVGLineElement; text: HTMLSpanElement }
  >();
  const worldNotes = new Map<string, HTMLSpanElement>();

  const showReferences = (frame: Frame, laid: GridReference[]) => {
    const seen = new Set<string>();
    for (const reference of laid) {
      seen.add(reference.text);
      let element = references.get(reference.text);
      if (!element) {
        element = create(parent, "span", "spyglass-note spyglass-reference");
        element.textContent = reference.text;
        letter(
          element,
          marginNote.font,
          inks.grid,
          marginNote.halo,
          inks.gridReferenceHalo
        );
        element.style.fontSize = `${marginNote.size}px`;
        references.set(reference.text, element);
      }
      const width =
        metrics.measure(reference.text, marginNote.font) * marginNote.size;
      const at = frame.screen(reference.x, reference.y, flatMarkHeight);
      // The text's middle at the point, as the painter's middle baseline put it.
      moveTo(
        element,
        at.x - width / 2,
        at.y - (squash * marginNote.size) / 2,
        frame.pixelRatio
      );
    }
    for (const [text, element] of references) {
      if (!seen.has(text)) {
        element.remove();
        references.delete(text);
      }
    }
  };

  const showScale = (frame: Frame, laid: LatitudeScale | null) => {
    scale.hidden = !laid;
    if (!laid) {
      return;
    }
    const { view } = frame;
    scale.style.opacity = `${laid.opacity}`;
    const { x } = frame.screen(laid.x, view.y, flatMarkHeight);
    const ys = laid.ticks.map(
      ({ y }) => frame.screen(laid.x, y, flatMarkHeight).y
    );
    const width = view.width * frame.pixels;
    const height = view.height * frame.pixels * squash;
    axis.setAttribute("width", `${width}`);
    axis.setAttribute("height", `${height}`);
    axis.setAttribute("viewBox", `0 0 ${width} ${height}`);
    setLine(axisLine, x, Math.min(...ys), x, Math.max(...ys));
    const seen = new Set<number>();
    for (const [i, each] of laid.ticks.entries()) {
      seen.add(each.layer);
      let shown = ticks.get(each.layer);
      if (!shown) {
        const text = create(
          scale,
          "span",
          "spyglass-note spyglass-latitude-label"
        );
        text.textContent = each.text;
        letter(text, marginNote.font, inks.scale, marginNote.halo);
        text.style.fontSize = `${marginNote.size}px`;
        shown = { line: tickLine(axis, axisStyle), text };
        ticks.set(each.layer, shown);
      }
      showTick(shown, x, ys[i] ?? 0, laid.plated, frame.pixelRatio);
    }
    for (const [layer, each] of ticks) {
      if (!seen.has(layer)) {
        each.line.remove();
        each.text.remove();
        ticks.delete(layer);
      }
    }
  };

  /** Sets one tick across the axis and its number to the west of it, on a plate on a narrow view. */
  const showTick = (
    shown: { line: SVGLineElement; text: HTMLSpanElement },
    x: number,
    y: number,
    plated: boolean,
    pixelRatio: number
  ) => {
    const { plateHeight, platePad, textGap, tick } = latitudeScaleStyle;
    setLine(shown.line, x - tick, y, x + tick, y);
    const text = shown.text.textContent ?? "";
    const textWidth = metrics.measure(text, marginNote.font) * marginNote.size;
    shown.text.classList.toggle("spyglass-plated", plated);
    shown.text.style.background = plated ? plate : "";
    const pad = plated ? platePad : 0;
    const lineHeight = plated ? plateHeight : marginNote.size;
    shown.text.style.lineHeight = `${lineHeight}px`;
    moveTo(
      shown.text,
      x - textGap - textWidth - pad,
      y - (squash * lineHeight) / 2,
      pixelRatio
    );
  };

  const showWorldNote = (key: string, note: WorldNote, frame: Frame) => {
    let element = worldNotes.get(key);
    if (!element) {
      element = create(parent, "span", `spyglass-note spyglass-${key}`);
      element.textContent = note.text;
      letter(element, note.font, note.ink, 0);
      worldNotes.set(key, element);
    }
    const size = note.size * frame.pixels;
    const width = metrics.measure(note.text, note.font) * size;
    const at = frame.screen(note.x, note.y, flatMarkHeight);
    element.style.fontSize = `${size}px`;
    moveTo(
      element,
      at.x - width / 2,
      at.y - squash * metrics.baseline(note.font) * size,
      frame.pixelRatio
    );
  };

  return {
    update(frame: Frame, labels: readonly MapLabel[]) {
      const { state, view } = frame;
      const data = state.drawingData;
      // Laid out and measured first, written second.
      const laidReferences = gridReferences(view, data, labels);
      const laidScale = latitudeScale(
        data,
        view,
        detailLevel(view.pixelsPerUnit).scale,
        state.legendHeight
      );
      const world = [
        ...seaCaption(data).map(
          (note, i) => [`sea-caption-${i}`, note] as const
        ),
        ["compass-letter", compassLetter(data)] as const,
      ];
      for (const reference of laidReferences) {
        metrics.measure(reference.text, marginNote.font);
      }
      for (const tick of laidScale?.ticks ?? []) {
        metrics.measure(tick.text, marginNote.font);
      }
      for (const [, note] of world) {
        metrics.measure(note.text, note.font);
        metrics.baseline(note.font);
      }
      showReferences(frame, laidReferences);
      showScale(frame, laidScale);
      for (const [key, note] of world) {
        showWorldNote(key, note, frame);
      }
    },
  };
}

/** A line of the latitude scale, in the scale's ink and weight. */
function tickLine(
  axis: SVGSVGElement,
  style: { hue: string; weight: number }
): SVGLineElement {
  const line = document.createElementNS(svgNamespace, "line");
  line.setAttribute("stroke", style.hue);
  line.setAttribute("stroke-width", `${style.weight}`);
  axis.append(line);
  return line;
}

function setLine(
  line: SVGLineElement,
  x1: number,
  y1: number,
  x2: number,
  y2: number
): void {
  line.setAttribute("x1", `${x1}`);
  line.setAttribute("y1", `${y1}`);
  line.setAttribute("x2", `${x2}`);
  line.setAttribute("y2", `${y2}`);
}
