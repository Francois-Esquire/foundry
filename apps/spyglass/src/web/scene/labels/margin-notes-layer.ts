import type { SpyglassData } from "../../data/types";
import { channels, inks } from "../../ladder/ink-ladder";
import type { MapLabel } from "../../layout/labels";
import {
  type GridReference,
  gridReferenceStyle,
  gridReferences,
  type LatitudeScale,
  latitudeScale,
  latitudeScaleStyle,
  marginNote,
  seaCaption,
  type WorldNote,
} from "../../layout/margin-notes";
import { flatMarkHeight } from "../../layout/terrain-height";
import { detailLevel } from "../../view/detail-level";
import { createFrameBorder } from "./frame-border";
import type { TextMetrics } from "./measure";
import {
  create,
  type Frame,
  keyedElements,
  letter,
  moveTo,
  setText,
  squash,
} from "./text-element";

const svgNamespace = "http://www.w3.org/2000/svg";

/** The paper plate under a latitude number on a narrow view: the labels' halo paper, at the plate's alpha. */
const plate = `rgb(${channels(inks.labelHalo).join(" ")} / ${latitudeScaleStyle.plateAlpha})`;

/** A tick of the latitude scale: its line across the axis, and its number. */
interface Tick {
  line: SVGLineElement;
  text: HTMLSpanElement;
}

/** A note set in map units, with the key its element is kept by. */
type KeyedNote = readonly [key: string, note: WorldNote];

/**
 * The margin notes, hidden from assistive technology: grid references along
 * the top and left margins, the latitude scale in the right margin, both in
 * screen space; the sea's caption anchored to the
 * chart, their size in pixels per unit, so they scale with the zoom as the
 * painted ones did. Each update lays the notes out and measures them first,
 * then writes. The plate's paper, padding and height are set once on the
 * notes' root as custom properties, which `.spyglass-plated` reads.
 */
export function createMarginNotes(parent: HTMLElement, metrics: TextMetrics) {
  const drawBorder = createFrameBorder(parent, metrics);
  const { plateHeight, platePad, textGap, tick } = latitudeScaleStyle;
  parent.style.setProperty("--spyglass-plate", plate);
  parent.style.setProperty("--spyglass-plate-pad", `${platePad}px`);
  parent.style.setProperty("--spyglass-plate-height", `${plateHeight}px`);
  const scale = create(parent, "div", "spyglass-latitude");
  const axis = document.createElementNS(svgNamespace, "svg");
  axis.setAttribute("class", "spyglass-latitude-axis");
  scale.append(axis);
  const { axis: axisStyle } = latitudeScaleStyle;
  const axisLine = tickLine(axis, axisStyle);

  const references = keyedElements<string, GridReference, HTMLSpanElement>({
    create(reference) {
      const element = create(
        parent,
        "span",
        "spyglass-note spyglass-reference"
      );
      element.textContent = reference.text;
      letter(
        element,
        gridReferenceStyle.font,
        inks.gridReference,
        gridReferenceStyle.halo,
        inks.gridReferenceHalo
      );
      return element;
    },
    key: (reference) => reference.text,
    retire: (element) => element.remove(),
  });

  const ticks = keyedElements<number, LatitudeScale["ticks"][number], Tick>({
    create(each) {
      const text = create(
        scale,
        "span",
        "spyglass-note spyglass-latitude-label"
      );
      text.textContent = each.text;
      letter(text, marginNote.font, inks.scale, marginNote.halo);
      text.style.fontSize = `${marginNote.size}px`;
      return { line: tickLine(axis, axisStyle), text };
    },
    key: (each) => each.layer,
    retire(each) {
      each.line.remove();
      each.text.remove();
    },
  });

  const worldNotes = keyedElements<string, KeyedNote, HTMLSpanElement>({
    create([key, note]) {
      const element = create(parent, "span", `spyglass-note spyglass-${key}`);
      element.textContent = note.text;
      letter(element, note.font, note.ink, 0);
      return element;
    },
    key: ([key]) => key,
    retire: (element) => element.remove(),
  });

  /** The notes set in map units, laid out once per chart: the sea's caption. */
  let worldFor: SpyglassData | undefined;
  let world: KeyedNote[] = [];
  const worldOf = (data: SpyglassData): KeyedNote[] => {
    if (data !== worldFor) {
      worldFor = data;
      world = [
        ...seaCaption(data).map(
          (note, i): KeyedNote => [`sea-caption-${i}`, note]
        ),
      ];
    }
    return world;
  };

  const showReferences = (frame: Frame, laid: GridReference[]) => {
    references.reconcile(laid, (element, reference) => {
      // The text's middle at the point, as the painter's middle baseline put it.
      setText(
        element,
        {
          align: "middle",
          at: frame.screen(reference.x, reference.y, flatMarkHeight),
          font: gridReferenceStyle.font,
          plane: "screen",
          size: gridReferenceStyle.size,
          text: reference.text,
        },
        frame,
        metrics
      );
    });
  };

  /** Sets one tick across the axis and its number to the west of it, on a plate on a narrow view. */
  const showTick = (
    shown: Tick,
    x: number,
    y: number,
    plated: boolean,
    pixelRatio: number
  ) => {
    setLine(shown.line, x - tick, y, x + tick, y);
    const text = shown.text.textContent ?? "";
    const textWidth = metrics.measure(text, marginNote.font) * marginNote.size;
    shown.text.classList.toggle("spyglass-plated", plated);
    const pad = plated ? platePad : 0;
    const lineHeight = plated ? plateHeight : marginNote.size;
    moveTo(
      shown.text,
      x - textGap - textWidth - pad,
      y - (squash * lineHeight) / 2,
      pixelRatio
    );
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
    setLine(axisLine, x, Math.min(...ys), x, Math.max(...ys));
    let i = 0;
    ticks.reconcile(laid.ticks, (shown) => {
      showTick(shown, x, ys[i] ?? 0, laid.plated, frame.pixelRatio);
      i += 1;
    });
  };

  const showWorldNotes = (frame: Frame, notes: KeyedNote[]) => {
    worldNotes.reconcile(notes, (element, [, note]) => {
      setText(
        element,
        {
          align: "baseline",
          at: frame.screen(note.x, note.y, flatMarkHeight),
          font: note.font,
          size: note.size * frame.pixels,
          text: note.text,
        },
        frame,
        metrics
      );
    });
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
      const notes = worldOf(data);
      for (const reference of laidReferences) {
        metrics.measure(reference.text, gridReferenceStyle.font);
      }
      for (const each of laidScale?.ticks ?? []) {
        metrics.measure(each.text, marginNote.font);
      }
      for (const [, note] of notes) {
        metrics.measure(note.text, note.font);
        metrics.baseline(note.font);
      }
      drawBorder(frame, laidReferences);
      showReferences(frame, laidReferences);
      showScale(frame, laidScale);
      showWorldNotes(frame, notes);
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
