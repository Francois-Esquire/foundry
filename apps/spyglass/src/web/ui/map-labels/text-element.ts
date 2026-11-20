import { inks } from "../../ladder/ink-ladder";
import type { LabelFont } from "../../layout/labels";
import type { ViewState } from "../../layout/view-state";
import { chartTilt, type InkView } from "../../view/chart-view";
import type { ScreenRect } from "./exclusions";
import { fontFamily, type TextMetrics } from "./measure";

export const squash = Math.cos(chartTilt);

export interface ScreenPoint {
  x: number;
  y: number;
}

export interface Frame {
  exclusions?: readonly ScreenRect[];
  pixelRatio: number;
  pixels: number;
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

function snap(value: number, pixelRatio: number): number {
  return Math.round(value * pixelRatio) / pixelRatio;
}

function moveTo(
  element: HTMLElement,
  left: number,
  top: number,
  pixelRatio: number,
  verticalScale = squash
): void {
  element.style.transform = `translate(${snap(left, pixelRatio)}px, ${snap(top, pixelRatio)}px) scaleY(${verticalScale})`;
}

interface Lettering {
  face: LabelFont["face"];
  halo: number;
  haloInk: string;
  ink: string;
  italic: boolean;
  letterSpacing: number;
}

const lettered = new WeakMap<HTMLElement, Lettering>();

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

interface TextPlacement {
  align: "baseline" | "middle";
  at: ScreenPoint;
  font: LabelFont;
  plane?: "chart" | "screen";
  size: number;
  text: string;
  width?: number;
}

export function setText(
  element: HTMLElement,
  placement: TextPlacement,
  frame: Frame,
  metrics: TextMetrics
): void {
  const { align, at, font, size, text } = placement;
  const width = placement.width ?? metrics.measure(text, font) * size;
  const verticalScale =
    placement.plane === "screen" || frame.view.tilt !== undefined ? 1 : squash;
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

export interface KeyedElements<K, V, T> {
  get: (key: K) => T | undefined;
  reconcile: (values: Iterable<V>, each: (entry: T, value: V) => void) => void;
  readonly size: number;
}

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
