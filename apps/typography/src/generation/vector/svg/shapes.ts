/** SVG basic shapes as contours. */
import type { Contour, Point, Segment } from "~/typeface/outline";
import { arcToCubics } from "./arc";
import type { XmlElement } from "./xml";

const NUMBER = /[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?/g;

const length = (element: XmlElement, name: string): number | undefined => {
  const value = Number.parseFloat(element.attributes[name] ?? "");
  return Number.isFinite(value) ? value : undefined;
};

const ellipse = (cx: number, cy: number, rx: number, ry: number): Contour[] => {
  if (rx <= 0 || ry <= 0) {
    return [];
  }
  const arc = { largeArc: false, rotation: 0, rx, ry, sweep: true };
  const stops: Point[] = [
    { x: cx + rx, y: cy },
    { x: cx, y: cy + ry },
    { x: cx - rx, y: cy },
    { x: cx, y: cy - ry },
    { x: cx + rx, y: cy },
  ];
  const segments: Segment[] = [];
  for (let index = 1; index < stops.length; index += 1) {
    const from = stops[index - 1];
    const to = stops[index];
    if (from && to) {
      segments.push(...arcToCubics(from, to, arc));
    }
  }
  return [{ segments, start: { x: cx + rx, y: cy } }];
};

const rectangle = (element: XmlElement): Contour[] => {
  const x = length(element, "x") ?? 0;
  const y = length(element, "y") ?? 0;
  const width = length(element, "width") ?? 0;
  const height = length(element, "height") ?? 0;
  if (width <= 0 || height <= 0) {
    return [];
  }
  const rx = Math.min(
    width / 2,
    length(element, "rx") ?? length(element, "ry") ?? 0
  );
  const ry = Math.min(
    height / 2,
    length(element, "ry") ?? length(element, "rx") ?? 0
  );
  const line = (px: number, py: number): Segment => ({
    kind: "line",
    to: { x: px, y: py },
  });
  if (rx <= 0 || ry <= 0) {
    return [
      {
        segments: [
          line(x + width, y),
          line(x + width, y + height),
          line(x, y + height),
        ],
        start: { x, y },
      },
    ];
  }
  const arc = { largeArc: false, rotation: 0, rx, ry, sweep: true };
  const corner = (from: Point, to: Point) => arcToCubics(from, to, arc);
  const right = x + width;
  const bottom = y + height;
  return [
    {
      segments: [
        line(right - rx, y),
        ...corner({ x: right - rx, y }, { x: right, y: y + ry }),
        line(right, bottom - ry),
        ...corner({ x: right, y: bottom - ry }, { x: right - rx, y: bottom }),
        line(x + rx, bottom),
        ...corner({ x: x + rx, y: bottom }, { x, y: bottom - ry }),
        line(x, y + ry),
        ...corner({ x, y: y + ry }, { x: x + rx, y }),
      ],
      start: { x: x + rx, y },
    },
  ];
};

const polygon = (element: XmlElement): Contour[] => {
  const values = (element.attributes.points ?? "").match(NUMBER) ?? [];
  const points: Point[] = [];
  for (let index = 0; index + 1 < values.length; index += 2) {
    points.push({ x: Number(values[index]), y: Number(values[index + 1]) });
  }
  const [start, ...rest] = points;
  return start && rest.length >= 2
    ? [{ segments: rest.map((to) => ({ kind: "line", to })), start }]
    : [];
};

/** The contours of a basic shape element, or nothing when it is not one. */
export const shapeContours = (element: XmlElement): Contour[] | undefined => {
  if (element.name === "rect") {
    return rectangle(element);
  }
  if (element.name === "polygon") {
    return polygon(element);
  }
  if (element.name === "circle") {
    const r = length(element, "r") ?? 0;
    return ellipse(
      length(element, "cx") ?? 0,
      length(element, "cy") ?? 0,
      r,
      r
    );
  }
  if (element.name === "ellipse") {
    return ellipse(
      length(element, "cx") ?? 0,
      length(element, "cy") ?? 0,
      length(element, "rx") ?? 0,
      length(element, "ry") ?? 0
    );
  }
};
