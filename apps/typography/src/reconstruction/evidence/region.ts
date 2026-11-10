/**
 * A region of evidence that holds lettering: a rectangle when the lettering
 * is seen head on, or four corner points when it is seen at an angle.
 */
import type { Point } from "~/typeface/outline";
import type { Region } from "~/typeface/provenance";

/** Corners in the order a reader meets them: top left, top right, bottom right, bottom left. */
export type Corners = readonly [Point, Point, Point, Point];

export type EvidenceRegion =
  | ({ readonly kind: "rectangle" } & Region)
  | { readonly kind: "quadrilateral"; readonly corners: Corners };

export const rectangleRegion = (
  x: number,
  y: number,
  width: number,
  height: number
): EvidenceRegion => ({ height, kind: "rectangle", width, x, y });

export const quadrilateralRegion = (corners: Corners): EvidenceRegion => ({
  corners,
  kind: "quadrilateral",
});

export const cornersOf = (region: EvidenceRegion): Corners => {
  if (region.kind === "quadrilateral") {
    return region.corners;
  }
  const { height, width, x, y } = region;
  return [
    { x, y },
    { x: x + width, y },
    { x: x + width, y: y + height },
    { x, y: y + height },
  ];
};

/** The upright box around a set of evidence points, as provenance records it. */
export const boxAround = (points: readonly Point[]): Region => {
  const xs = points.map((point) => point.x);
  const ys = points.map((point) => point.y);
  const x = Math.min(...xs);
  const y = Math.min(...ys);
  return {
    height: Math.max(...ys) - y,
    width: Math.max(...xs) - x,
    x,
    y,
  };
};
