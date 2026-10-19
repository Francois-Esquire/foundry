import { inks } from "../../ladder/ink-ladder";
import type { LabelFont } from "../../layout/labels";
import { chartTilt, type InkView } from "../../view/chart-view";
import type { ViewState } from "../view-state";
import { fontFamily, type TextMetrics } from "./measure";

/**
 * The labels layer's elements: how a text element is made, lettered and
 * moved on screen, and how a set of them keyed by what they show is kept
 * across frames.
 */

/** The tilt's foreshortening: lettering on the chart is squashed by it, as the engraved look has it. */
export const squash = Math.cos(chartTilt);

/** A point on screen, in CSS pixels of the host. */
export interface ScreenPoint {
  x: number;
  y: number;
}

/** Everything one update of the layer reads: the view, the frame's state, and the screen. */
export interface Frame {
  pixelRatio: number;
  pixels: number;
  /** A chart point (y south) at a world height, on screen. */
  screen: (x: number, y: number, z: number) => ScreenPoint;
  state: Readonly<ViewState>;
  view: InkView;
}

export function create<K extends keyof HTMLElementTagNameMap>(
  parent: Element,
  tag: K,
  className: string
): HTMLElementTagNameMap[K] {
  const element = document.createElement(tag);
  element.className = className;
  parent.append(element);
  return element;
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
export function moveTo(
  element: HTMLElement,
  left: number,
  top: number,
  pixelRatio: number,
  verticalScale = squash
): void {
  element.style.transform = `translate(${snap(left, pixelRatio)}px, ${snap(top, pixelRatio)}px) scaleY(${verticalScale})`;
}

/** How an element was last lettered: the styles that hold until the font, the ink or the halo changes. */
interface Lettering {
  face: LabelFont["face"];
  halo: number;
  haloInk: string;
  ink: string;
  italic: boolean;
  letterSpacing: number;
}

const lettered = new WeakMap<HTMLElement, Lettering>();

/**
 * Sets how a text is lettered: its face, italics, the space between its
 * letters, its ink and the paper halo it is cut from. Written once, and
 * again only when any of them changes, as they do when the selected file
 * flips; a still frame writes none of them.
 */
export function letter(
  element: HTMLElement,
  font: LabelFont,
  ink: string,
  halo: number,
  haloInk: string = inks.labelHalo
): void {
  const italic = font.italic ?? false;
  const last = lettered.get(element);
  if (
    last &&
    last.face === font.face &&
    last.italic === italic &&
    last.letterSpacing === font.letterSpacing &&
    last.ink === ink &&
    last.halo === halo &&
    last.haloInk === haloInk
  ) {
    return;
  }
  lettered.set(element, {
    face: font.face,
    halo,
    haloInk,
    ink,
    italic,
    letterSpacing: font.letterSpacing,
  });
  element.style.fontFamily = fontFamily(font);
  element.style.fontStyle = italic ? "italic" : "normal";
  element.style.letterSpacing = `${font.letterSpacing}em`;
  element.style.color = ink;
  element.style.webkitTextStroke = halo ? `${halo}px ${haloInk}` : "";
}

/** A text to set on screen: what it says, how it is set, its size in CSS pixels, and the point its text is centred on. */
interface TextPlacement {
  /** Which line of the text sits at the point: its baseline, as a name's anchor has it, or its middle, as a painter's middle baseline put a note. */
  align: "baseline" | "middle";
  at: ScreenPoint;
  font: LabelFont;
  /** Margin furniture stays upright while place names follow the chart tilt. */
  plane?: "chart" | "screen";
  size: number;
  text: string;
  /** The box's width when wider than the text, as a name's is over a wider caption; the text's own otherwise. */
  width?: number;
}

/**
 * Sets a text element at its size, its text centred on a point: the
 * element's top-left is the point less half the width and the squashed
 * distance from the top to the line aligned on the point.
 */
export function setText(
  element: HTMLElement,
  placement: TextPlacement,
  frame: Frame,
  metrics: TextMetrics
): void {
  const { align, at, font, size, text } = placement;
  const width = placement.width ?? metrics.measure(text, font) * size;
  const verticalScale = placement.plane === "screen" ? 1 : squash;
  const down = align === "baseline" ? metrics.baseline(font) : 0.5;
  element.style.fontSize = `${size}px`;
  moveTo(
    element,
    at.x - width / 2,
    at.y - verticalScale * down * size,
    frame.pixelRatio,
    verticalScale
  );
}

/** A set of entries kept by key across frames: `reconcile` makes, keeps and retires them against the values a frame shows. */
export interface KeyedElements<K, V, T> {
  get: (key: K) => T | undefined;
  /**
   * Keeps one entry for each value, by its key: a new key makes an entry, a
   * kept key keeps its entry, and every key not among the values has its
   * entry retired. `each` is then called on every entry, in the values'
   * order.
   */
  reconcile: (values: Iterable<V>, each: (entry: T, value: V) => void) => void;
  readonly size: number;
}

/**
 * Elements keyed by what they show, so a pan or a zoom moves an element
 * rather than replacing it. `create` makes the entry for a value, `key`
 * names it, and `retire` removes an entry whose key the frame no longer
 * shows.
 */
export function keyedElements<K, V, T>(options: {
  create: (value: V) => T;
  key: (value: V) => K;
  retire: (entry: T) => void;
}): KeyedElements<K, V, T> {
  const { create: make, key: keyOf, retire } = options;
  const entries = new Map<K, T>();
  const seen = new Set<K>();
  return {
    get: (key) => entries.get(key),
    reconcile(values, each) {
      seen.clear();
      for (const value of values) {
        const key = keyOf(value);
        seen.add(key);
        let entry = entries.get(key);
        if (entry === undefined) {
          entry = make(value);
          entries.set(key, entry);
        }
        each(entry, value);
      }
      for (const [key, entry] of entries) {
        if (!seen.has(key)) {
          retire(entry);
          entries.delete(key);
        }
      }
    },
    get size() {
      return entries.size;
    },
  };
}
