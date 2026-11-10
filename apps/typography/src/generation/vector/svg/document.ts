/**
 * Reads an SVG file into filled shapes. Paths and basic shapes are read with
 * the transforms of their element and every group around them. A glyph is a
 * filled shape, so strokes and text are reported as defects, not drawn.
 */
import {
  type Outline,
  outlineBounds,
  type Transform,
  transformOutline,
} from "~/typeface/outline";
import {
  isKnownPaint,
  type Presentation,
  paintOf,
  parseStyleRules,
  presentationOf,
  type StyleRules,
} from "./paint";
import { parsePathData } from "./path-data";
import { shapeContours } from "./shapes";
import { composeTransforms, IDENTITY, parseTransform } from "./transform";
import { parseXml, type XmlElement } from "./xml";

export interface SvgShape {
  /** 1 for a black fill, 0 for white. Light shapes are usually paper or painted-out counters. */
  readonly darkness: number;
  /** The element the shape came from, for example `path`. */
  readonly element: string;
  readonly evenOdd: boolean;
  /** In the document's own coordinates, so y points down. */
  readonly outline: Outline;
}

type SvgDefectKind =
  | "stroke"
  | "text"
  | "unknown-paint"
  | "unsupported-element";

interface SvgDefect {
  readonly detail: string;
  readonly kind: SvgDefectKind;
}

/** The part of the drawing the file shows. */
interface ViewBox {
  readonly height: number;
  readonly width: number;
  readonly x: number;
  readonly y: number;
}

export interface SvgDocument {
  readonly defects: readonly SvgDefect[];
  /** Filled shapes in painting order: later shapes cover earlier ones. */
  readonly shapes: readonly SvgShape[];
  readonly viewBox: ViewBox;
}

/** Elements whose contents are definitions, not drawing. */
const DEFINITIONS = new Set([
  "clipPath",
  "defs",
  "linearGradient",
  "marker",
  "mask",
  "metadata",
  "pattern",
  "radialGradient",
  "style",
  "symbol",
  "title",
  "desc",
]);
const GROUPS = new Set(["a", "g", "svg", "switch"]);
const TEXT = new Set(["text", "tspan", "textPath"]);
const NUMBER = /[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?/g;

interface Walk {
  readonly defects: SvgDefect[];
  readonly rules: StyleRules;
  readonly shapes: SvgShape[];
}

const contoursOf = (element: XmlElement) =>
  element.name === "path"
    ? parsePathData(element.attributes.d ?? "")
    : shapeContours(element);

const addShape = (
  walk: Walk,
  element: XmlElement,
  presentation: Presentation,
  transform: Transform
) => {
  const contours = contoursOf(element);
  if (!contours) {
    walk.defects.push({
      detail: `<${element.name}> is not read.`,
      kind: "unsupported-element",
    });
    return;
  }
  const paint = paintOf(presentation);
  if (paint.hidden || contours.length === 0) {
    return;
  }
  if (paint.stroked) {
    walk.defects.push({
      detail: `<${element.name}> has a stroke, which is not part of the filled shape.`,
      kind: "stroke",
    });
  }
  if (!isKnownPaint(presentation.fill)) {
    walk.defects.push({
      detail: `<${element.name}> is filled with ${presentation.fill}, read as solid ink.`,
      kind: "unknown-paint",
    });
  }
  if (paint.filled) {
    walk.shapes.push({
      darkness: isKnownPaint(presentation.fill)
        ? paint.darkness
        : paint.opacity,
      element: element.name,
      evenOdd: paint.evenOdd,
      outline: transformOutline({ contours }, transform),
    });
  }
};

const visit = (
  walk: Walk,
  element: XmlElement,
  inherited: Presentation,
  outer: Transform
) => {
  if (DEFINITIONS.has(element.name)) {
    return;
  }
  if (TEXT.has(element.name)) {
    walk.defects.push({
      detail: `Text "${element.text.trim()}" is not part of any glyph.`,
      kind: "text",
    });
    return;
  }
  const presentation = presentationOf(element, inherited, walk.rules);
  const transform = composeTransforms(
    outer,
    parseTransform(element.attributes.transform)
  );
  if (!GROUPS.has(element.name)) {
    addShape(walk, element, presentation, transform);
    return;
  }
  if (presentation.display !== "none") {
    for (const child of element.children) {
      visit(walk, child, presentation, transform);
    }
  }
};

const collectStyles = (element: XmlElement): string =>
  (element.name === "style" ? element.text : "") +
  element.children.map(collectStyles).join("\n");

const viewBoxOf = (root: XmlElement, shapes: readonly SvgShape[]): ViewBox => {
  const [x, y, width, height] = (root.attributes.viewBox ?? "")
    .match(NUMBER)
    ?.map(Number) ?? [undefined];
  if (x !== undefined && y !== undefined && width && height) {
    return { height, width, x, y };
  }
  const declaredWidth = Number.parseFloat(root.attributes.width ?? "");
  const declaredHeight = Number.parseFloat(root.attributes.height ?? "");
  if (declaredWidth > 0 && declaredHeight > 0) {
    return { height: declaredHeight, width: declaredWidth, x: 0, y: 0 };
  }
  const bounds = outlineBounds({
    contours: shapes.flatMap((shape) => shape.outline.contours),
  });
  return bounds
    ? {
        height: bounds.yMax - bounds.yMin,
        width: bounds.xMax - bounds.xMin,
        x: bounds.xMin,
        y: bounds.yMin,
      }
    : { height: 0, width: 0, x: 0, y: 0 };
};

/** Reads an SVG file. Throws `MalformedXmlError` when it is not well formed. */
export const parseSvg = (source: string): SvgDocument => {
  const root = parseXml(source);
  const walk: Walk = {
    defects: [],
    rules: parseStyleRules(collectStyles(root)),
    shapes: [],
  };
  visit(walk, root, {}, IDENTITY);
  return {
    defects: walk.defects,
    shapes: walk.shapes,
    viewBox: viewBoxOf(root, walk.shapes),
  };
};
