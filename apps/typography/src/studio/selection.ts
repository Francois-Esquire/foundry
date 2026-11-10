/** Which points of an outline are selected, and the ways a selection changes. */
import type { Outline, Point } from "~/typeface/outline";
import {
  addressKey,
  type EditablePoint,
  editablePoints,
  type PointAddress,
} from "~/typeface/outline-editing";

export type Selection = readonly PointAddress[];

export const EMPTY_SELECTION: Selection = [];

export interface SegmentAddress {
  readonly contour: number;
  readonly segment: number;
}

export const isSelected = (selection: Selection, address: PointAddress) => {
  const key = addressKey(address);
  return selection.some((selected) => addressKey(selected) === key);
};

/** Adds the point when it is not selected and removes it when it is. */
export const toggleSelected = (
  selection: Selection,
  address: PointAddress
): Selection => {
  const key = addressKey(address);
  return isSelected(selection, address)
    ? selection.filter((selected) => addressKey(selected) !== key)
    : [...selection, address];
};

/** Names a selection whatever order it was made in, so two can be compared. */
export const selectionKey = (selection: Selection) =>
  selection.map(addressKey).sort().join(" ");

/** Position round the ring: a node, then the handles of the segment that leaves it. */
const ringPosition = (address: PointAddress) =>
  address.kind === "node"
    ? address.node * 3
    : address.segment * 3 + 1 + address.which;

/** Every point in the order a pen would meet them, contour by contour. */
export const pointsInOrder = (outline: Outline): EditablePoint[] =>
  editablePoints(outline).toSorted(
    (a, b) =>
      a.address.contour - b.address.contour ||
      ringPosition(a.address) - ringPosition(b.address)
  );

export const selectAll = (outline: Outline): Selection =>
  pointsInOrder(outline).map((point) => point.address);

/** Drops the points an outline no longer has, as after an undo. */
export const keepExisting = (
  outline: Outline,
  selection: Selection
): Selection => {
  if (selection.length === 0) {
    return selection;
  }
  const existing = new Set(
    editablePoints(outline).map((point) => addressKey(point.address))
  );
  const kept = selection.filter((address) => existing.has(addressKey(address)));
  return kept.length === selection.length ? selection : kept;
};

/** The points inside the box between two corners, in font units. */
export const pointsInBox = (
  outline: Outline,
  corner: Point,
  opposite: Point
): Selection => {
  const xMin = Math.min(corner.x, opposite.x);
  const xMax = Math.max(corner.x, opposite.x);
  const yMin = Math.min(corner.y, opposite.y);
  const yMax = Math.max(corner.y, opposite.y);
  return pointsInOrder(outline)
    .filter(
      ({ point }) =>
        point.x >= xMin && point.x <= xMax && point.y >= yMin && point.y <= yMax
    )
    .map((point) => point.address);
};

/** Both selections together, each point once. */
export const selectedTogether = (
  first: Selection,
  second: Selection
): Selection => {
  const keys = new Set(first.map(addressKey));
  return [
    ...first,
    ...second.filter((address) => !keys.has(addressKey(address))),
  ];
};

/**
 * The selection after stepping to the next or previous point, for choosing
 * points from the keyboard. Stepping from nothing starts at the first point,
 * or the last when stepping back. Extending keeps what was selected.
 */
export const stepSelection = (
  outline: Outline,
  selection: Selection,
  direction: -1 | 1,
  extend = false
): Selection => {
  const order = pointsInOrder(outline).map((point) => point.address);
  if (order.length === 0) {
    return EMPTY_SELECTION;
  }
  const last = selection.at(-1);
  const from = last
    ? order.findIndex((address) => addressKey(address) === addressKey(last))
    : -1;
  let index = direction === 1 ? 0 : order.length - 1;
  if (from !== -1) {
    index = (from + direction + order.length) % order.length;
  }
  const next = order[index];
  if (!next) {
    return selection;
  }
  return extend ? selectedTogether(selection, [next]) : [next];
};

const nodeCounts = (outline: Outline) => {
  const counts = new Map<number, number>();
  for (const { address } of editablePoints(outline)) {
    if (address.kind === "node") {
      counts.set(address.contour, (counts.get(address.contour) ?? 0) + 1);
    }
  }
  return counts;
};

/**
 * The segments a selection stands for: one whose handle is selected, or whose
 * two end nodes are both selected. A single selected node alone stands for
 * the segment that leaves it.
 */
export const segmentsOf = (
  outline: Outline,
  selection: Selection
): SegmentAddress[] => {
  const counts = nodeCounts(outline);
  const nodes = new Set(
    selection
      .filter((address) => address.kind === "node")
      .map((address) => addressKey(address))
  );
  const found = new Map<string, SegmentAddress>();
  const add = (contour: number, segment: number) =>
    found.set(`${contour}:${segment}`, { contour, segment });
  for (const address of selection) {
    if (address.kind === "handle") {
      add(address.contour, address.segment);
      continue;
    }
    const count = counts.get(address.contour) ?? 0;
    const next = (address.node + 1) % count;
    if (
      count > 1 &&
      nodes.has(
        addressKey({ contour: address.contour, kind: "node", node: next })
      )
    ) {
      add(address.contour, address.node);
    }
  }
  const [only] = selection;
  if (found.size === 0 && selection.length === 1 && only?.kind === "node") {
    add(only.contour, only.node);
  }
  return [...found.values()].sort(
    (a, b) => a.contour - b.contour || a.segment - b.segment
  );
};
