/** Deleting several nodes at once. */
import type { Contour, Outline, Point } from "~/typeface/outline";
import { deleteNode, editablePoints } from "~/typeface/outline-editing";
import type { Selection } from "./selection";

const nodesOf = (outline: Outline) =>
  editablePoints(outline).filter((point) => point.address.kind === "node");

/** Deleting a node renumbers its contour, so each doomed node is found again by where it is. */
const withoutNodesAt = (contour: Contour, doomed: readonly Point[]) => {
  let remaining: Outline = { contours: [contour] };
  for (const target of doomed) {
    const found = nodesOf(remaining).find(
      ({ point }) => point.x === target.x && point.y === target.y
    );
    if (found?.address.kind === "node") {
      remaining = deleteNode(remaining, 0, found.address.node);
    }
  }
  return remaining.contours;
};

/**
 * Removes every selected node and joins its neighbours. A contour left too
 * small to enclose anything goes with its nodes. Selected handles are ignored.
 */
export const deleteNodes = (
  outline: Outline,
  selection: Selection
): Outline => {
  const doomed = new Map<number, Point[]>();
  for (const { address, point } of nodesOf(outline)) {
    const selected = selection.some(
      (chosen) =>
        chosen.kind === "node" &&
        address.kind === "node" &&
        chosen.contour === address.contour &&
        chosen.node === address.node
    );
    if (selected) {
      doomed.set(address.contour, [
        ...(doomed.get(address.contour) ?? []),
        point,
      ]);
    }
  }
  if (doomed.size === 0) {
    return outline;
  }
  return {
    contours: outline.contours.flatMap((contour, index) => {
      const points = doomed.get(index);
      return points ? withoutNodesAt(contour, points) : [contour];
    }),
  };
};
