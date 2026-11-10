/**
 * How an SVG element is painted, as far as a glyph cares: whether it is
 * filled, how dark the fill is, and whether it carries a stroke.
 */
import type { XmlElement } from "./xml";

export interface Paint {
  /** 1 for black, 0 for white or a fill that cannot be seen. */
  readonly darkness: number;
  readonly evenOdd: boolean;
  readonly filled: boolean;
  readonly hidden: boolean;
  readonly opacity: number;
  readonly stroked: boolean;
}

/** Presentation properties after inheritance, still as written. */
export type Presentation = Readonly<Record<string, string | undefined>>;

/** Style rules from a `<style>` element, by simple selector. */
export type StyleRules = ReadonlyMap<string, Presentation>;

const INHERITED = new Set([
  "fill",
  "fill-opacity",
  "fill-rule",
  "stroke",
  "stroke-width",
  "visibility",
]);
const PROPERTIES = [...INHERITED, "display", "opacity"];

const NAMED: Readonly<
  Record<string, readonly [number, number, number] | undefined>
> = {
  black: [0, 0, 0],
  blue: [0, 0, 255],
  gray: [128, 128, 128],
  green: [0, 128, 0],
  grey: [128, 128, 128],
  red: [255, 0, 0],
  silver: [192, 192, 192],
  white: [255, 255, 255],
};

const HEX = /^#([0-9a-f]{3,8})$/i;
const FUNCTIONAL = /^rgba?\(([^)]*)\)$/i;
const CHANNEL_SEPARATOR = /[\s,/]+/;
const DECLARATION_SEPARATOR = /\s*;\s*/;
const RULE = /([^{}]+)\{([^{}]*)\}/g;
const SELECTOR_SEPARATOR = /\s*,\s*/;
const WHITESPACE = /\s+/;

const channel = (text: string) =>
  text.endsWith("%") ? (Number.parseFloat(text) * 255) / 100 : Number(text);

const hexChannels = (digits: string): number[] => {
  const wide =
    digits.length <= 4
      ? [...digits].map((digit) => digit + digit).join("")
      : digits;
  return [0, 2, 4].map((at) => Number.parseInt(wide.slice(at, at + 2), 16));
};

/** Red, green and blue from 0 to 255, or nothing for a paint this reader does not know. */
const colourOf = (value: string): readonly number[] | undefined => {
  const text = value.trim().toLowerCase();
  const hex = HEX.exec(text)?.[1];
  if (hex) {
    return hexChannels(hex);
  }
  const functional = FUNCTIONAL.exec(text)?.[1];
  if (functional) {
    return functional.trim().split(CHANNEL_SEPARATOR).slice(0, 3).map(channel);
  }
  return text === "currentcolor" ? NAMED.black : NAMED[text];
};

const darknessOf = (value: string): number => {
  const [red = 0, green = 0, blue = 0] = colourOf(value) ?? [];
  return 1 - (0.2126 * red + 0.7152 * green + 0.0722 * blue) / 255;
};

const declarations = (style: string | undefined): Record<string, string> => {
  const found: Record<string, string> = {};
  for (const declaration of (style ?? "").split(DECLARATION_SEPARATOR)) {
    const colon = declaration.indexOf(":");
    if (colon > 0) {
      found[declaration.slice(0, colon).trim().toLowerCase()] = declaration
        .slice(colon + 1)
        .trim();
    }
  }
  return found;
};

/** Reads the rules of a style sheet. Only tag, class and id selectors are understood. */
export const parseStyleRules = (css: string): StyleRules => {
  const rules = new Map<string, Presentation>();
  for (const [, selectors = "", body = ""] of css.matchAll(RULE)) {
    for (const selector of selectors.trim().split(SELECTOR_SEPARATOR)) {
      rules.set(selector, { ...rules.get(selector), ...declarations(body) });
    }
  }
  return rules;
};

const ruleStyles = (element: XmlElement, rules: StyleRules): Presentation => {
  const classes = (element.attributes.class ?? "")
    .split(WHITESPACE)
    .filter((name) => name !== "")
    .map((name) => `.${name}`);
  const id = element.attributes.id ? [`#${element.attributes.id}`] : [];
  return Object.assign(
    {},
    ...[element.name, ...classes, ...id].map((selector) => rules.get(selector))
  );
};

/** An element's presentation: what it inherits, then its rules, attributes and inline style. */
export const presentationOf = (
  element: XmlElement,
  inherited: Presentation,
  rules: StyleRules
): Presentation => {
  const own: Record<string, string | undefined> = {};
  const fromRules = ruleStyles(element, rules);
  const inline: Presentation = declarations(element.attributes.style);
  for (const property of PROPERTIES) {
    const value =
      inline[property] ?? fromRules[property] ?? element.attributes[property];
    if (value !== undefined) {
      own[property] = value;
    }
  }
  const passedDown = Object.fromEntries(
    Object.entries(inherited).filter(([property]) => INHERITED.has(property))
  );
  const opacity = Number(inherited.opacity ?? 1) * Number(own.opacity ?? 1);
  const display =
    inherited.display === "none" ? "none" : (own.display ?? "inline");
  return { ...passedDown, ...own, display, opacity: String(opacity) };
};

const isPainted = (value: string | undefined, fallback: boolean) =>
  value === undefined ? fallback : !["none", "transparent"].includes(value);

export const paintOf = (presentation: Presentation): Paint => {
  const fill = presentation.fill ?? "black";
  const opacity =
    Number(presentation.opacity ?? 1) *
    Number(presentation["fill-opacity"] ?? 1);
  return {
    darkness: darknessOf(fill) * opacity,
    evenOdd: presentation["fill-rule"] === "evenodd",
    filled: isPainted(presentation.fill, true) && opacity > 0,
    hidden:
      presentation.display === "none" || presentation.visibility === "hidden",
    opacity,
    stroked:
      isPainted(presentation.stroke, false) &&
      Number.parseFloat(presentation["stroke-width"] ?? "1") > 0,
  };
};

/** Whether a fill value names a colour this reader can judge the darkness of. */
export const isKnownPaint = (value: string | undefined) =>
  value === undefined ||
  ["none", "transparent"].includes(value) ||
  colourOf(value) !== undefined;
