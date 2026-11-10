/**
 * Glyph geometry in font units, with y pointing up. Outlines are immutable
 * values: every operation returns a new outline.
 */

export interface Point {
  readonly x: number;
  readonly y: number;
}

export type Segment =
  | { readonly kind: "line"; readonly to: Point }
  | { readonly kind: "quadratic"; readonly control: Point; readonly to: Point }
  | {
      readonly kind: "cubic";
      readonly control1: Point;
      readonly control2: Point;
      readonly to: Point;
    };

/** A closed path. It returns to `start` even when the last segment does not. */
export interface Contour {
  readonly segments: readonly Segment[];
  readonly start: Point;
}

export interface Outline {
  readonly contours: readonly Contour[];
}

export interface Bounds {
  readonly xMax: number;
  readonly xMin: number;
  readonly yMax: number;
  readonly yMin: number;
}

/** x' = xx·x + yx·y + dx and y' = xy·x + yy·y + dy. */
export interface Transform {
  readonly dx: number;
  readonly dy: number;
  readonly xx: number;
  readonly xy: number;
  readonly yx: number;
  readonly yy: number;
}

export const EMPTY_OUTLINE: Outline = { contours: [] };

const segmentPoints = (segment: Segment): readonly Point[] => {
  if (segment.kind === "line") {
    return [segment.to];
  }
  if (segment.kind === "quadratic") {
    return [segment.control, segment.to];
  }
  return [segment.control1, segment.control2, segment.to];
};

/** Every point that defines the outline: starts, controls and segment ends. */
export const outlinePoints = (outline: Outline): Point[] =>
  outline.contours.flatMap((contour) => [
    contour.start,
    ...contour.segments.flatMap(segmentPoints),
  ]);

const mapSegment = (
  segment: Segment,
  map: (point: Point) => Point
): Segment => {
  if (segment.kind === "line") {
    return { kind: "line", to: map(segment.to) };
  }
  if (segment.kind === "quadratic") {
    return {
      control: map(segment.control),
      kind: "quadratic",
      to: map(segment.to),
    };
  }
  return {
    control1: map(segment.control1),
    control2: map(segment.control2),
    kind: "cubic",
    to: map(segment.to),
  };
};

export const mapOutline = (
  outline: Outline,
  map: (point: Point) => Point
): Outline => ({
  contours: outline.contours.map((contour) => ({
    segments: contour.segments.map((segment) => mapSegment(segment, map)),
    start: map(contour.start),
  })),
});

export const transformOutline = (outline: Outline, t: Transform): Outline =>
  mapOutline(outline, ({ x, y }) => ({
    x: t.xx * x + t.yx * y + t.dx,
    y: t.xy * x + t.yy * y + t.dy,
  }));

export const translateOutline = (
  outline: Outline,
  dx: number,
  dy: number
): Outline => mapOutline(outline, ({ x, y }) => ({ x: x + dx, y: y + dy }));

export const roundOutline = (outline: Outline): Outline =>
  mapOutline(outline, ({ x, y }) => ({ x: Math.round(x), y: Math.round(y) }));

/** Parameters in (0, 1) where one coordinate of a curve reaches an extreme. */
const quadraticExtreme = (
  from: number,
  control: number,
  to: number
): number[] => {
  const denominator = from - 2 * control + to;
  if (denominator === 0) {
    return [];
  }
  const t = (from - control) / denominator;
  return t > 0 && t < 1 ? [t] : [];
};

const cubicExtremes = (
  from: number,
  c1: number,
  c2: number,
  to: number
): number[] => {
  const a = -from + 3 * c1 - 3 * c2 + to;
  const b = 2 * (from - 2 * c1 + c2);
  const c = c1 - from;
  if (Math.abs(a) < 1e-12) {
    return b === 0 ? [] : [-c / b].filter((t) => t > 0 && t < 1);
  }
  const discriminant = b * b - 4 * a * c;
  if (discriminant < 0) {
    return [];
  }
  const root = Math.sqrt(discriminant);
  return [(-b + root) / (2 * a), (-b - root) / (2 * a)].filter(
    (t) => t > 0 && t < 1
  );
};

const quadraticAt = (from: number, control: number, to: number, t: number) =>
  (1 - t) ** 2 * from + 2 * (1 - t) * t * control + t ** 2 * to;

const cubicAt = (from: number, c1: number, c2: number, to: number, t: number) =>
  (1 - t) ** 3 * from +
  3 * (1 - t) ** 2 * t * c1 +
  3 * (1 - t) * t ** 2 * c2 +
  t ** 3 * to;

const segmentExtremes = (from: Point, segment: Segment): Point[] => {
  if (segment.kind === "line") {
    return [segment.to];
  }
  if (segment.kind === "quadratic") {
    const { control, to } = segment;
    const at = (t: number) => ({
      x: quadraticAt(from.x, control.x, to.x, t),
      y: quadraticAt(from.y, control.y, to.y, t),
    });
    return [
      to,
      ...quadraticExtreme(from.x, control.x, to.x).map(at),
      ...quadraticExtreme(from.y, control.y, to.y).map(at),
    ];
  }
  const { control1, control2, to } = segment;
  const at = (t: number) => ({
    x: cubicAt(from.x, control1.x, control2.x, to.x, t),
    y: cubicAt(from.y, control1.y, control2.y, to.y, t),
  });
  return [
    to,
    ...cubicExtremes(from.x, control1.x, control2.x, to.x).map(at),
    ...cubicExtremes(from.y, control1.y, control2.y, to.y).map(at),
  ];
};

/** The exact box around the drawn curves, not around their control points. */
export const outlineBounds = (outline: Outline): Bounds | undefined => {
  const extremes: Point[] = [];
  for (const contour of outline.contours) {
    let from = contour.start;
    extremes.push(from);
    for (const segment of contour.segments) {
      extremes.push(...segmentExtremes(from, segment));
      from = segment.to;
    }
  }
  if (extremes.length === 0) {
    return;
  }
  const xs = extremes.map((point) => point.x);
  const ys = extremes.map((point) => point.y);
  return {
    xMax: Math.max(...xs),
    xMin: Math.min(...xs),
    yMax: Math.max(...ys),
    yMin: Math.min(...ys),
  };
};

const format = (value: number) => Number(value.toFixed(3)).toString();

const segmentToPath = (segment: Segment): string => {
  if (segment.kind === "line") {
    return `L${format(segment.to.x)} ${format(segment.to.y)}`;
  }
  if (segment.kind === "quadratic") {
    const { control, to } = segment;
    return `Q${format(control.x)} ${format(control.y)} ${format(to.x)} ${format(to.y)}`;
  }
  const { control1, control2, to } = segment;
  return `C${format(control1.x)} ${format(control1.y)} ${format(control2.x)} ${format(control2.y)} ${format(to.x)} ${format(to.y)}`;
};

/** SVG path data in font units. The caller flips the y axis when drawing. */
export const outlineToPath = (outline: Outline): string =>
  outline.contours
    .map(
      (contour) =>
        `M${format(contour.start.x)} ${format(contour.start.y)}${contour.segments.map(segmentToPath).join("")}Z`
    )
    .join("");
