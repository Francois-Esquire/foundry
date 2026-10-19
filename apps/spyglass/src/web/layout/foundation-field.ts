import type { FoundationGroup, Polygon } from "../../lib/visualization/types";
import { fillPolygon } from "./scanline-fill";

interface GroupMask {
  edges: Uint8Array;
  group: FoundationGroup;
  height: number;
  left: number;
  mask: Uint8Array;
  top: number;
  width: number;
}

function rasterGroup(
  group: FoundationGroup,
  width: number,
  height: number,
  extent: { width: number; height: number }
): GroupMask {
  const polygons = group.footprint.map((polygon) =>
    polygon.map((ring) =>
      ring.map(([x, y]): [number, number] => [
        (x / extent.width + 0.5) * width,
        (y / extent.height + 0.5) * height,
      ])
    )
  );
  let left = width;
  let right = 0;
  let top = height;
  let bottom = 0;
  for (const polygon of polygons) {
    for (const ring of polygon) {
      for (const [x, y] of ring) {
        left = Math.min(left, Math.floor(x));
        right = Math.max(right, Math.ceil(x));
        top = Math.min(top, Math.floor(y));
        bottom = Math.max(bottom, Math.ceil(y));
      }
    }
  }
  left = Math.max(0, left);
  top = Math.max(0, top);
  right = Math.min(width, right);
  bottom = Math.min(height, bottom);
  const columns = Math.max(0, right - left);
  const rows = Math.max(0, bottom - top);
  const { mask, edges } = rasterCrop(polygons, columns, rows, left, top);
  return { edges, group, height: rows, left, mask, top, width: columns };
}

function rasterCrop(
  polygons: Polygon[],
  columns: number,
  rows: number,
  left: number,
  top: number
) {
  const mask = new Uint8Array(columns * rows);
  const edges = new Uint8Array(mask.length);
  if (columns && rows) {
    // Sample one cell beyond the crop: clipping is not a dependency boundary.
    const paddedWidth = columns + 2;
    const padded = new Uint8Array(paddedWidth * (rows + 2));
    for (const polygon of polygons) {
      fillPolygon(
        padded,
        paddedWidth,
        rows + 2,
        polygon.map((ring) =>
          ring.map(([x, y]): [number, number] => [x - left + 1, y - top + 1])
        )
      );
    }
    for (let row = 0; row < rows; row += 1) {
      for (let column = 0; column < columns; column += 1) {
        const index = row * columns + column;
        const source = (row + 1) * paddedWidth + column + 1;
        mask[index] = padded[source] ?? 0;
        if (
          mask[index] &&
          !(
            padded[source - 1] &&
            padded[source + 1] &&
            padded[source - paddedWidth] &&
            padded[source + paddedWidth]
          )
        ) {
          edges[index] = 1;
        }
      }
    }
  }
  return { edges, mask };
}

/** Rasterize each baked footprint once. Cropped masks retain independent groups for focus. */
export function createFoundationFields(
  groups: readonly FoundationGroup[],
  extent: { width: number; height: number },
  resolution = 768
) {
  const validExtent =
    Number.isFinite(extent.width) &&
    Number.isFinite(extent.height) &&
    extent.width > 0 &&
    extent.height > 0;
  const samples = Number.isFinite(resolution) ? Math.max(2, resolution) : 2;
  const scale = validExtent
    ? samples / Math.max(extent.width, extent.height)
    : 0;
  const width = validExtent ? Math.max(2, Math.ceil(extent.width * scale)) : 2;
  const height = validExtent
    ? Math.max(2, Math.ceil(extent.height * scale))
    : 2;
  const masks = validExtent
    ? groups.map((group) => rasterGroup(group, width, height, extent))
    : [];
  return {
    compose(focus = "") {
      const values = new Float32Array(width * height * 2);
      for (const item of masks) {
        if (
          focus &&
          item.group.id !== focus &&
          !item.group.dependencyIds.includes(focus)
        ) {
          continue;
        }
        for (let row = 0; row < item.height; row += 1) {
          for (let column = 0; column < item.width; column += 1) {
            const source = row * item.width + column;
            const target = ((row + item.top) * width + column + item.left) * 2;
            values[target] = (values[target] ?? 0) + (item.mask[source] ?? 0);
            values[target + 1] =
              (values[target + 1] ?? 0) + (item.edges[source] ?? 0);
          }
        }
      }
      return { height, values, width };
    },
    height,
    width,
  };
}

/** Interior and boundary counts preserve actual overlap, without an overview cutoff. */
export function foundationField(
  groups: readonly FoundationGroup[],
  extent: { width: number; height: number },
  focus = "",
  resolution = 768
) {
  return createFoundationFields(groups, extent, resolution).compose(focus);
}
