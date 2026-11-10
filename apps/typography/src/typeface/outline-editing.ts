/**
 * Point-level editing of an outline. Every operation takes an outline and
 * returns a new one. A contour is treated as a ring of nodes (the points on
 * the curve) joined by segments, each of which may carry handles (the points
 * off the curve).
 */
import type { Contour, Outline, Point, Segment } from "./outline";

/** Names one editable point. Segment `n` runs from node `n` to the next node round the ring. */
export type PointAddress =
  | { readonly kind: "node"; readonly contour: number; readonly node: number }
  | {
      readonly kind: "handle";
      readonly contour: number;
      readonly segment: number;
      readonly which: 0 | 1;
    };

export interface EditablePoint {
  readonly address: PointAddress;
  /** For a handle, the node it hangs from. */
  readonly anchor?: Point;
  readonly point: Point;
}

export interface SegmentHit {
  readonly contour: number;
  readonly distance: number;
  readonly point: Point;
  readonly segment: number;
  /** Position along the segment, from 0 to 1. */
  readonly t: number;
}

const SAMPLES_PER_SEGMENT = 32;

const samePoint = (a: Point, b: Point) => a.x === b.x && a.y === b.y;

const lerp = (a: Point, b: Point, t: number): Point => ({
  x: a.x + (b.x - a.x) * t,
  y: a.y + (b.y - a.y) * t,
});

const distance = (a: Point, b: Point) => Math.hypot(a.x - b.x, a.y - b.y);

export const addressKey = (address: PointAddress) =>
  address.kind === "node"
    ? `n:${address.contour}:${address.node}`
    : `h:${address.contour}:${address.segment}:${address.which}`;

/**
 * A contour as a ring: its last segment always ends on its first node, so
 * node `n` is where segment `n` begins and there are as many nodes as segments.
 */
const asRing = (contour: Contour): Contour => {
  const last = contour.segments.at(-1);
  if (last && samePoint(last.to, contour.start)) {
    return contour;
  }
  return {
    segments: [...contour.segments, { kind: "line", to: contour.start }],
    start: contour.start,
  };
};

const nodeAt = (ring: Contour, node: number): Point =>
  node === 0 ? ring.start : (ring.segments[node - 1]?.to ?? ring.start);

const segmentAt = (ring: Contour, segment: number): Segment | undefined =>
  ring.segments[
    ((segment % ring.segments.length) + ring.segments.length) %
      ring.segments.length
  ];

const handlesOf = (segment: Segment): Point[] => {
  if (segment.kind === "quadratic") {
    return [segment.control];
  }
  return segment.kind === "cubic" ? [segment.control1, segment.control2] : [];
};

/** Every point a person can grab: nodes first, then handles, contour by contour. */
export const editablePoints = (outline: Outline): EditablePoint[] =>
  outline.contours.flatMap((contour, contourIndex) => {
    const ring = asRing(contour);
    const count = ring.segments.length;
    const nodes = ring.segments.map(
      (_, node): EditablePoint => ({
        address: { contour: contourIndex, kind: "node", node },
        point: nodeAt(ring, node),
      })
    );
    const handles = ring.segments.flatMap((segment, index) =>
      handlesOf(segment).map((point, position): EditablePoint => {
        // A quadratic handle and a cubic's first handle hang from the node the
        // segment leaves. A cubic's second handle hangs from the node it reaches.
        const hangsFromEnd = segment.kind === "cubic" && position === 1;
        return {
          address: {
            contour: contourIndex,
            kind: "handle",
            segment: index,
            which: position === 0 ? 0 : 1,
          },
          anchor: nodeAt(ring, hangsFromEnd ? (index + 1) % count : index),
          point,
        };
      })
    );
    return [...nodes, ...handles];
  });

const moveHandle = (
  segment: Segment,
  which: 0 | 1,
  move: (point: Point) => Point
): Segment => {
  if (segment.kind === "quadratic" && which === 0) {
    return { ...segment, control: move(segment.control) };
  }
  if (segment.kind === "cubic") {
    return which === 0
      ? { ...segment, control1: move(segment.control1) }
      : { ...segment, control2: move(segment.control2) };
  }
  return segment;
};

/**
 * Moves points by a distance. A moved node carries the cubic handles that
 * hang from it, so the curve keeps its shape through the node.
 */
export const movePoints = (
  outline: Outline,
  addresses: readonly PointAddress[],
  dx: number,
  dy: number
): Outline => {
  const move = (point: Point): Point => ({ x: point.x + dx, y: point.y + dy });
  const contours = outline.contours.map((contour, contourIndex) => {
    const selected = addresses.filter(
      (address) => address.contour === contourIndex
    );
    if (selected.length === 0) {
      return contour;
    }
    const ring = asRing(contour);
    const count = ring.segments.length;
    const nodes = new Set<number>();
    const handles = new Set<string>();
    for (const address of selected) {
      if (address.kind === "node") {
        nodes.add(address.node);
        handles.add(`${address.node}:0:carried`);
        handles.add(`${(address.node - 1 + count) % count}:1:carried`);
      } else {
        handles.add(`${address.segment}:${address.which}`);
      }
    }
    const segments = ring.segments.map((segment, index) => {
      let next = segment;
      for (const which of [0, 1] as const) {
        // A carried handle only moves on a cubic: a quadratic's single handle
        // belongs to both of its nodes and stays where it is.
        const carried =
          handles.has(`${index}:${which}:carried`) && segment.kind === "cubic";
        if (handles.has(`${index}:${which}`) || carried) {
          next = moveHandle(next, which, move);
        }
      }
      return nodes.has((index + 1) % count)
        ? { ...next, to: move(next.to) }
        : next;
    });
    return { segments, start: nodes.has(0) ? move(ring.start) : ring.start };
  });
  return { contours };
};

const splitSegment = (
  from: Point,
  segment: Segment,
  t: number
): [Segment, Segment] => {
  if (segment.kind === "line") {
    return [
      { kind: "line", to: lerp(from, segment.to, t) },
      { kind: "line", to: segment.to },
    ];
  }
  if (segment.kind === "quadratic") {
    const first = lerp(from, segment.control, t);
    const second = lerp(segment.control, segment.to, t);
    return [
      { control: first, kind: "quadratic", to: lerp(first, second, t) },
      { control: second, kind: "quadratic", to: segment.to },
    ];
  }
  const a = lerp(from, segment.control1, t);
  const b = lerp(segment.control1, segment.control2, t);
  const c = lerp(segment.control2, segment.to, t);
  const ab = lerp(a, b, t);
  const bc = lerp(b, c, t);
  return [
    { control1: a, control2: ab, kind: "cubic", to: lerp(ab, bc, t) },
    { control1: bc, control2: c, kind: "cubic", to: segment.to },
  ];
};

const replaceContour = (
  outline: Outline,
  index: number,
  contour: Contour | undefined
): Outline => ({
  contours: outline.contours.flatMap((existing, position) => {
    if (position !== index) {
      return [existing];
    }
    return contour ? [contour] : [];
  }),
});

/** Adds a node on a segment without changing the shape. */
export const insertNode = (
  outline: Outline,
  contour: number,
  segment: number,
  t: number
): Outline => {
  const source = outline.contours[contour];
  if (!source) {
    return outline;
  }
  const ring = asRing(source);
  const target = ring.segments[segment];
  if (!target) {
    return outline;
  }
  const [first, second] = splitSegment(
    nodeAt(ring, segment),
    target,
    Math.min(1, Math.max(0, t))
  );
  return replaceContour(outline, contour, {
    segments: [
      ...ring.segments.slice(0, segment),
      first,
      second,
      ...ring.segments.slice(segment + 1),
    ],
    start: ring.start,
  });
};

/** Turns the ring so that a different node comes first. The shape is unchanged. */
const startAt = (ring: Contour, node: number): Contour => {
  const count = ring.segments.length;
  const turn = ((node % count) + count) % count;
  if (turn === 0) {
    return ring;
  }
  return {
    segments: [...ring.segments.slice(turn), ...ring.segments.slice(0, turn)],
    start: nodeAt(ring, turn),
  };
};

const joinSegments = (
  from: Point,
  incoming: Segment,
  outgoing: Segment
): Segment => {
  if (incoming.kind === "line" && outgoing.kind === "line") {
    return { kind: "line", to: outgoing.to };
  }
  return {
    control1: handlesOf(incoming)[0] ?? from,
    control2: handlesOf(outgoing).at(-1) ?? outgoing.to,
    kind: "cubic",
    to: outgoing.to,
  };
};

/**
 * Removes a node and joins its neighbours. A contour needs three nodes to
 * enclose anything, so removing a node from a smaller one removes the contour.
 */
export const deleteNode = (
  outline: Outline,
  contour: number,
  node: number
): Outline => {
  const source = outline.contours[contour];
  if (!source) {
    return outline;
  }
  const ring = asRing(source);
  if (
    ring.segments.length <= 3 &&
    ring.segments.every((segment) => segment.kind === "line")
  ) {
    return replaceContour(outline, contour, undefined);
  }
  if (ring.segments.length <= 2) {
    return replaceContour(outline, contour, undefined);
  }
  // Put the doomed node second, so its two segments are the first two.
  const turned = startAt(ring, node - 1);
  const [incoming, outgoing, ...rest] = turned.segments;
  if (!(incoming && outgoing)) {
    return outline;
  }
  return replaceContour(outline, contour, {
    segments: [joinSegments(turned.start, incoming, outgoing), ...rest],
    start: turned.start,
  });
};

/** Makes a segment straight, or gives a straight segment handles a third of the way along. */
export const convertSegment = (
  outline: Outline,
  contour: number,
  segment: number,
  kind: "line" | "cubic"
): Outline => {
  const source = outline.contours[contour];
  if (!source) {
    return outline;
  }
  const ring = asRing(source);
  const target = ring.segments[segment];
  if (!target || target.kind === kind) {
    return outline;
  }
  const from = nodeAt(ring, segment);
  const converted: Segment =
    kind === "line"
      ? { kind: "line", to: target.to }
      : {
          control1: handlesOf(target)[0] ?? lerp(from, target.to, 1 / 3),
          control2: handlesOf(target).at(-1) ?? lerp(from, target.to, 2 / 3),
          kind: "cubic",
          to: target.to,
        };
  return replaceContour(outline, contour, {
    segments: ring.segments.map((existing, index) =>
      index === segment ? converted : existing
    ),
    start: ring.start,
  });
};

export const deleteContour = (outline: Outline, contour: number): Outline =>
  replaceContour(outline, contour, undefined);

const pointOn = (from: Point, segment: Segment, t: number): Point => {
  if (segment.kind === "line") {
    return lerp(from, segment.to, t);
  }
  if (segment.kind === "quadratic") {
    return lerp(
      lerp(from, segment.control, t),
      lerp(segment.control, segment.to, t),
      t
    );
  }
  const a = lerp(from, segment.control1, t);
  const b = lerp(segment.control1, segment.control2, t);
  const c = lerp(segment.control2, segment.to, t);
  return lerp(lerp(a, b, t), lerp(b, c, t), t);
};

/** The point nearest to a position, if one lies within reach. Nodes win ties over handles. */
export const nearestPoint = (
  outline: Outline,
  position: Point,
  reach: number
): EditablePoint | undefined => {
  let best: EditablePoint | undefined;
  let bestDistance = reach;
  for (const candidate of editablePoints(outline)) {
    const away = distance(candidate.point, position);
    if (away < bestDistance || (away === bestDistance && !best)) {
      best = candidate;
      bestDistance = away;
    }
  }
  return best;
};

/** The place on the outline nearest to a position, for adding a node there. */
export const nearestSegment = (
  outline: Outline,
  position: Point
): SegmentHit | undefined => {
  let best: SegmentHit | undefined;
  outline.contours.forEach((contour, contourIndex) => {
    const ring = asRing(contour);
    ring.segments.forEach((segment, index) => {
      const from = nodeAt(ring, index);
      for (let step = 0; step <= SAMPLES_PER_SEGMENT; step += 1) {
        const t = step / SAMPLES_PER_SEGMENT;
        const point = pointOn(from, segment, t);
        const away = distance(point, position);
        if (!best || away < best.distance) {
          best = {
            contour: contourIndex,
            distance: away,
            point,
            segment: index,
            t,
          };
        }
      }
    });
  });
  return best;
};

/** The node a segment starts from and the node it reaches, for drawing and labelling. */
export const segmentEnds = (
  outline: Outline,
  contour: number,
  segment: number
): { readonly from: Point; readonly to: Point } | undefined => {
  const source = outline.contours[contour];
  if (!source) {
    return;
  }
  const ring = asRing(source);
  const target = segmentAt(ring, segment);
  return target && { from: nodeAt(ring, segment), to: target.to };
};
